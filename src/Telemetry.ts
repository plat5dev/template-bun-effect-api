import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import {
  PrometheusExporter,
  PrometheusSerializer
} from "@opentelemetry/exporter-prometheus"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler
} from "@opentelemetry/sdk-trace-base"
import { Context, Effect, Layer } from "effect"
import { AppConfig } from "./AppConfig.js"
import { registerProcessMetrics } from "./plat5/ProcessMetrics.js"

const normalizeEndpoint = (base: string, suffix: string): string => {
  const trimmed = base.replace(/\/$/, "")
  if (trimmed.endsWith(suffix)) {
    return trimmed
  }
  return `${trimmed}${suffix}`
}

const exporterIncludes = (
  list: ReadonlyArray<string> | undefined,
  name: string
): boolean => (list ?? []).includes(name)

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

type TelemetryConfig = Context.Tag.Service<AppConfig>

const tracesDestination = (config: TelemetryConfig): string | undefined =>
  config.otlpTracesEndpoint ??
  (config.otlpEndpoint ? normalizeEndpoint(config.otlpEndpoint, "/v1/traces") : undefined)

const metricsDestination = (config: TelemetryConfig): string | undefined =>
  config.otlpMetricsEndpoint ??
  (config.otlpEndpoint ? normalizeEndpoint(config.otlpEndpoint, "/v1/metrics") : undefined)

/** Traces OTLP when destination exists and exporter allows otlp (default on). */
const tracesOtlpEnabled = (config: TelemetryConfig): boolean => {
  if (config.otelSdkDisabled) return false
  if (!tracesDestination(config)) return false
  if (config.tracesExporters === undefined) return true
  return exporterIncludes(config.tracesExporters, "otlp")
}

/**
 * Metrics OTLP when destination exists and exporter allows otlp (default on).
 * `/metrics` scrape stays on regardless. Set OTEL_METRICS_EXPORTER=prometheus to push-off.
 */
const metricsOtlpEnabled = (config: TelemetryConfig): boolean => {
  if (config.otelSdkDisabled) return false
  if (!metricsDestination(config)) return false
  if (config.metricsExporters === undefined) return true
  return exporterIncludes(config.metricsExporters, "otlp")
}

export const TelemetryLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const config = yield* AppConfig

    const prometheus = new PrometheusExporter({ preventServerStart: true })
    const serializer = new PrometheusSerializer("", false)

    const scrapeLive = Layer.succeed(MetricsScrape, {
      collect: Effect.tryPromise({
        try: async () => {
          const { resourceMetrics, errors } = await prometheus.collect()
          if (errors.length > 0) {
            console.error(
              JSON.stringify({
                timestamp: new Date().toISOString(),
                level: "error",
                message: "prometheus metrics collection errors",
                error_kind: "internal",
                error_message: errors.map(String).join("; ")
              })
            )
          }
          return serializer.serialize(resourceMetrics)
        },
        catch: (cause) =>
          new Error(`metrics scrape failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      }).pipe(Effect.orDie)
    })

    // Peer dep type drift between exporter-prometheus and sdk-metrics MetricReader.
    const metricReaders: NodeSdk.Configuration["metricReader"] = metricsOtlpEnabled(config)
      ? [
        prometheus as never,
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: metricsDestination(config)! }),
          exportIntervalMillis: config.metricExportIntervalMs
        })
      ]
      : (prometheus as never)

    const ratio = Math.min(1, Math.max(0, config.tracesSamplerRatio))
    const spanProcessor = tracesOtlpEnabled(config)
      ? new BatchSpanProcessor(
        new OTLPTraceExporter({ url: tracesDestination(config)! })
      )
      : undefined

    // OTEL_RESOURCE_ATTRIBUTES first; convenience identity attrs win on collision.
    const sdkLive = NodeSdk.layer(() => ({
      resource: {
        serviceName: config.serviceName,
        serviceVersion: config.serviceVersion,
        attributes: {
          ...config.resourceAttributes,
          "service.namespace": config.serviceNamespace,
          "service.instance.id": config.serviceInstanceId,
          "deployment.environment": config.deploymentEnv
        }
      },
      spanProcessor,
      tracerConfig: spanProcessor
        ? {
          sampler: new ParentBasedSampler({
            root: new TraceIdRatioBasedSampler(ratio)
          })
        }
        : undefined,
      metricReader: metricReaders
    })).pipe(
      Layer.tap(() => Effect.sync(() => registerProcessMetrics()))
    )

    return Layer.merge(sdkLive, scrapeLive)
  })
).pipe(Layer.provide(AppConfig.Live))
