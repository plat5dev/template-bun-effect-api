/**
 * Telemetry (plat5 docs/reference/telemetry.md), with Effect's own: logs as Plat5's JSON
 * lines, Effect's metrics on `/metrics` and, with a destination, pushed over OTLP, and spans
 * pushed over OTLP, sampled by OTEL_TRACES_SAMPLER_RATIO.
 */
import { Effect, Layer, Option, Schedule, Tracer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { OtlpMetrics, OtlpSerialization, OtlpTracer, PrometheusMetrics } from "effect/observability"
import * as Log from "./plat5/Log.js"
import { updateProcessMetrics } from "./plat5/ProcessMetrics.js"
import { TelemetryConfig } from "./TelemetryConfig.js"

/** The Prometheus text for `/metrics`: every Effect metric, the process ones brought up to now. */
export const scrape: Effect.Effect<string> = Effect.andThen(updateProcessMetrics, PrometheusMetrics.format())

/**
 * The client the OTLP exporters send with. An export that fails, the collector unreachable
 * say, is one JSON `error` line each time; the API keeps serving.
 */
const ExportClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.transform(client, (response, request) =>
      response.pipe(
        Effect.tap((res) =>
          res.status >= 300
            ? Log.telemetryError(`${request.method} ${request.url} answered ${res.status}`)
            : Effect.void
        ),
        Effect.tapError((error) => Log.telemetryError(error.message))
      ))
  )
).pipe(Layer.provide(FetchHttpClient.layer))

/** New traces are sampled at `ratio`; a span with a parent is sampled as its parent is. */
const sampledAt = (ratio: number) =>
  Layer.effect(
    Tracer.Tracer,
    Effect.map(Effect.tracer, (tracer) =>
      Tracer.make({
        context: tracer.context?.bind(tracer),
        span: (options) =>
          tracer.span(Option.isNone(options.parent) ? { ...options, sampled: Math.random() < ratio } : options)
      })
    )
  )

export const TelemetryLive = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* TelemetryConfig
    const { "service.name": serviceName, "service.version": serviceVersion } = config.resource
    const resource = { serviceName, serviceVersion, attributes: config.resource }

    const traces = config.otlpTracesUrl === undefined
      ? Layer.empty
      : Layer.provideMerge(
        sampledAt(config.tracesSamplerRatio),
        OtlpTracer.layer({ url: config.otlpTracesUrl, resource, headers: config.otlpTracesHeaders })
      )
    const metrics = config.otlpMetricsUrl === undefined
      ? Layer.empty
      : OtlpMetrics.layer({
        url: config.otlpMetricsUrl,
        resource,
        headers: config.otlpMetricsHeaders,
        exportInterval: config.metricExportIntervalMs
      })
    // OTLP gets the process metrics as they move; a scrape brings them up to date itself.
    const processMetrics = Layer.effectDiscard(
      updateProcessMetrics.pipe(Effect.repeat(Schedule.spaced(config.metricExportIntervalMs)), Effect.forkScoped)
    )

    const exporters = Layer.mergeAll(traces, metrics, processMetrics).pipe(
      Layer.provide([OtlpSerialization.layerProtobuf, ExportClient, Log.layer])
    )
    // The app's logs, and the exporters' own, are Plat5's lines.
    return Layer.merge(exporters, Log.layer)
  })
)
