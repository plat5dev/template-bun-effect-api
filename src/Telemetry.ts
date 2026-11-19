/**
 * Native Effect observability: Prometheus `/metrics` scrape, process metrics,
 * and opt-in OTLP trace + metric push when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 */
import { Effect, Layer, Metric, Option, Schedule, Tracer } from "effect"
import { HttpClient } from "effect/http"
import { OtlpMetrics, OtlpSerialization, OtlpTracer, PrometheusMetrics } from "effect/observability"
import { TelemetryConfig } from "./Config.js"
import * as Log from "./plat5/Log.js"

const residentMemory = Metric.gauge("process_resident_memory_bytes", {
  description: "Resident memory size in bytes"
})
const cpuSeconds = Metric.counter("process_cpu_seconds_total", {
  description: "Total user and system CPU time spent in seconds",
  incremental: true
})
const startTime = Metric.gauge("process_start_time_seconds", {
  description: "Start time of the process since unix epoch in seconds"
})

const startedAt = Date.now() / 1000 - process.uptime()
let cpuCounted = 0

export const updateProcessMetrics: Effect.Effect<void> = Effect.suspend(() => {
  const usage = process.cpuUsage()
  const cpu = (usage.user + usage.system) / 1_000_000
  const delta = cpu - cpuCounted
  cpuCounted = cpu
  return Effect.all([
    Metric.update(residentMemory, process.memoryUsage().rss),
    Metric.update(cpuSeconds, delta),
    Metric.update(startTime, startedAt)
  ], { discard: true })
})

/** Prometheus text for `/metrics`, refreshing process gauges on scrape. */
export const scrape: Effect.Effect<string> = Effect.andThen(updateProcessMetrics, PrometheusMetrics.format())

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
)

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

/**
 * Installs OTLP trace and metric exporters when configured.
 * Process metrics run on a background interval only when OTLP metrics push is active;
 * `/metrics` scrapes always refresh process metrics on demand.
 */
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
      : Layer.mergeAll(
        OtlpMetrics.layer({
          url: config.otlpMetricsUrl,
          resource,
          headers: config.otlpMetricsHeaders,
          exportInterval: config.metricExportIntervalMs
        }),
        Layer.effectDiscard(
          updateProcessMetrics.pipe(
            Effect.repeat(Schedule.spaced(config.metricExportIntervalMs)),
            Effect.forkScoped
          )
        )
      )

    return Layer.mergeAll(traces, metrics).pipe(
      Layer.provide([OtlpSerialization.layerProtobuf, ExportClient])
    )
  })
)
