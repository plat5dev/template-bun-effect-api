import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as Tracer from "@effect/opentelemetry/Tracer"
import { diag, type DiagLogger, DiagLogLevel } from "@opentelemetry/api"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import {
  PrometheusExporter,
  PrometheusSerializer
} from "@opentelemetry/exporter-prometheus"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler
} from "@opentelemetry/sdk-trace-base"
import { Context, Effect, Layer } from "effect"
import { AppConfig } from "./AppConfig.js"
import { HttpServerSpanStatusLive } from "./plat5/HttpObservability.js"
import { registerProcessMetrics } from "./plat5/ProcessMetrics.js"

/** An error's message: OpenTelemetry hands an exception over as JSON, stack and all. */
const messageOf = (text: string): string => {
  try {
    const parsed: unknown = JSON.parse(text)
    const message = (parsed as { message?: unknown } | null)?.message
    if (typeof message === "string") return message
  } catch {
    // Not JSON: the text is the message.
  }
  return text
}

/** An OpenTelemetry error or warning, a failed export say, as one JSON line on stdout. */
const logLine = (level: "error" | "warn", message: string) => (text: string, ...args: Array<unknown>): void => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      error_message: [messageOf(text), ...args.map(String)].join(" ")
    })
  )
}

/** OpenTelemetry's errors and warnings, a failed export say, each one JSON line; the API keeps serving. */
export const diagLogger: DiagLogger = {
  error: logLine("error", "telemetry error"),
  warn: logLine("warn", "telemetry warning"),
  info: () => undefined,
  debug: () => undefined,
  verbose: () => undefined
}

/**
 * Prometheus text scrape for internal `/metrics`.
 * Always available (contract: scrape on even when OTLP is off).
 */
export class MetricsScrape extends Context.Tag("MetricsScrape")<
  MetricsScrape,
  {
    readonly collect: Effect.Effect<string>
  }
>() {}

export const TelemetryLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const config = yield* AppConfig

    diag.setLogger(diagLogger, DiagLogLevel.WARN)

    const otlpMetricReader = () =>
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: config.otlpMetricsUrl! }),
        exportIntervalMillis: config.metricExportIntervalMs
      })

    // Effect's metrics (HTTP, DB) reach these readers through NodeSdk; the process series
    // are OpenTelemetry instruments, on a MeterProvider of their own with its own readers.
    const prometheus = new PrometheusExporter({ preventServerStart: true })
    const processPrometheus = new PrometheusExporter({ preventServerStart: true })
    const processLive = Layer.scopedDiscard(
      Effect.acquireRelease(
        Effect.sync(() => {
          const provider = new MeterProvider({
            resource: resourceFromAttributes(config.resource),
            readers: config.otlpMetricsUrl !== undefined
              ? [processPrometheus, otlpMetricReader()]
              : [processPrometheus]
          })
          registerProcessMetrics(provider.getMeter("process"))
          return provider
        }),
        (provider) => Effect.promise(() => provider.shutdown()).pipe(Effect.ignore)
      )
    )
    const serializer = new PrometheusSerializer("", false)

    const scrapeLive = Layer.succeed(MetricsScrape, {
      collect: Effect.tryPromise({
        try: async () => {
          const collected = await Promise.all([prometheus.collect(), processPrometheus.collect()])
          const errors = collected.flatMap((c) => c.errors)
          if (errors.length > 0) {
            console.error(
              JSON.stringify({
                timestamp: new Date().toISOString(),
                level: "error",
                message: "prometheus metrics collection errors",
                error_type: "internal",
                error_message: errors.map(String).join("; ")
              })
            )
          }
          return collected.map((c) => serializer.serialize(c.resourceMetrics)).join("")
        },
        catch: (cause) =>
          new Error(`metrics scrape failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      }).pipe(Effect.orDie)
    })

    // Peer dep type drift between exporter-prometheus and sdk-metrics MetricReader.
    const metricReaders: NodeSdk.Configuration["metricReader"] = config.otlpMetricsUrl !== undefined
      ? [prometheus as never, otlpMetricReader()]
      : (prometheus as never)

    const spanProcessor = config.otlpTracesUrl !== undefined
      ? new BatchSpanProcessor(new OTLPTraceExporter({ url: config.otlpTracesUrl }))
      : undefined

    // AppConfig layers the resource; it wins over NodeSdk's own read of the environment.
    const sdkLive = NodeSdk.layer(() => ({
      resource: {
        serviceName: config.resource["service.name"]!,
        serviceVersion: config.resource["service.version"]!,
        attributes: config.resource
      },
      spanProcessor,
      tracerConfig: spanProcessor
        ? {
          sampler: new ParentBasedSampler({
            root: new TraceIdRatioBasedSampler(config.tracesSamplerRatio)
          })
        }
        : undefined,
      metricReader: metricReaders
    }))

    // Without OTLP traces, spans go to OpenTelemetry's no-op tracer: a request's span is
    // its traceparent's, so that goes on to identity as it came.
    const otelLive = spanProcessor ? sdkLive : Layer.provideMerge(Tracer.layerGlobal, sdkLive)
    const tracingLive = Layer.provideMerge(HttpServerSpanStatusLive, otelLive)

    return Layer.mergeAll(tracingLive, processLive, scrapeLive)
  })
).pipe(Layer.provide(AppConfig.Live))
