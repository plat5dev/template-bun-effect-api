import { Config, Context, Effect, Layer } from "effect"
import { hostname } from "node:os"

const optionalNonEmpty = (name: string) =>
  Config.option(Config.string(name)).pipe(
    Effect.map((opt) => (opt._tag === "Some" && opt.value.trim() !== "" ? opt.value.trim() : undefined))
  )

/** Comma-separated exporter list → lowercased tokens (empty if unset). */
const optionalExporterList = (name: string) =>
  optionalNonEmpty(name).pipe(
    Effect.map((raw) => {
      if (raw === undefined) return undefined
      const parts = raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0)
      return parts
    })
  )

/** Parse OTEL_RESOURCE_ATTRIBUTES (`key=value,key2=value2`). */
const parseResourceAttributes = (raw: string | undefined): Record<string, string> => {
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key) out[key] = value
  }
  return out
}

export class AppConfig extends Context.Tag("AppConfig")<
  AppConfig,
  {
    readonly port: number
    readonly internalPort: number
    readonly databasePath: string
    readonly serviceName: string
    readonly serviceNamespace: string
    readonly serviceVersion: string
    readonly serviceInstanceId: string
    readonly deploymentEnv: string
    /** From OTEL_RESOURCE_ATTRIBUTES; convenience identity attrs override these. */
    readonly resourceAttributes: Readonly<Record<string, string>>
    readonly otlpEndpoint: string | undefined
    readonly otlpTracesEndpoint: string | undefined
    readonly otlpMetricsEndpoint: string | undefined
    /** unset → default (otlp when destination exists) */
    readonly tracesExporters: ReadonlyArray<string> | undefined
    /** unset → otlp when destination exists; `/metrics` always on */
    readonly metricsExporters: ReadonlyArray<string> | undefined
    readonly otelSdkDisabled: boolean
    readonly metricExportIntervalMs: number
    readonly tracesSamplerRatio: number
  }
>() {
  static readonly Live = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const port = yield* Config.integer("PORT").pipe(Config.withDefault(3000))
      const internalPort = yield* Config.integer("INTERNAL_PORT").pipe(Config.withDefault(3001))
      const databasePath = yield* Config.string("DATABASE_PATH").pipe(
        Config.withDefault("./data/app.db")
      )
      const serviceName = yield* Config.string("OTEL_SERVICE_NAME").pipe(Config.withDefault("api"))
      const serviceNamespace = yield* Config.string("OTEL_SERVICE_NAMESPACE").pipe(
        Config.withDefault("api")
      )
      const serviceVersion = yield* Config.string("OTEL_SERVICE_VERSION").pipe(
        Config.withDefault("0.0.0")
      )
      const serviceInstanceId = yield* Config.string("OTEL_SERVICE_INSTANCE_ID").pipe(
        Config.withDefault(hostname())
      )
      const deploymentEnvOtel = yield* optionalNonEmpty("OTEL_DEPLOYMENT_ENV")
      const deploymentEnv =
        deploymentEnvOtel ??
        (yield* Config.string("DEPLOYMENT_ENV").pipe(Config.withDefault("development")))
      const resourceAttributesRaw = yield* optionalNonEmpty("OTEL_RESOURCE_ATTRIBUTES")
      const resourceAttributes = parseResourceAttributes(resourceAttributesRaw)
      const otlpEndpoint = yield* optionalNonEmpty("OTEL_EXPORTER_OTLP_ENDPOINT")
      const otlpTracesEndpoint = yield* optionalNonEmpty("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
      const otlpMetricsEndpoint = yield* optionalNonEmpty("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")
      const tracesExporters = yield* optionalExporterList("OTEL_TRACES_EXPORTER")
      const metricsExporters = yield* optionalExporterList("OTEL_METRICS_EXPORTER")
      const otelSdkDisabled = yield* Config.boolean("OTEL_SDK_DISABLED").pipe(
        Config.withDefault(false)
      )
      const metricExportIntervalMs = yield* Config.integer("OTEL_METRIC_EXPORT_INTERVAL").pipe(
        Config.withDefault(30_000)
      )
      const tracesSamplerRatio = yield* Config.number("OTEL_TRACES_SAMPLER_RATIO").pipe(
        Config.withDefault(1)
      )

      return {
        port,
        internalPort,
        databasePath,
        serviceName,
        serviceNamespace,
        serviceVersion,
        serviceInstanceId,
        deploymentEnv,
        resourceAttributes,
        otlpEndpoint,
        otlpTracesEndpoint,
        otlpMetricsEndpoint,
        tracesExporters,
        metricsExporters,
        otelSdkDisabled,
        metricExportIntervalMs,
        tracesSamplerRatio
      } as const
    })
  )
}
