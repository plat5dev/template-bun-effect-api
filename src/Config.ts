/**
 * Application and telemetry configuration loaded via Effect Config.
 */
import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"

const PERMISSION_NAME = /^[a-z0-9:._-]{1,64}$/

const optionalString = (name: string): Config.Config<string | undefined> =>
  Config.option(Config.String(name)).pipe(
    Config.map((opt) => {
      const value = Option.getOrUndefined(opt)
      return value === undefined || value === "" ? undefined : value
    })
  )

const optionalTrimmed = (name: string): Config.Config<string | undefined> =>
  optionalString(name).pipe(Config.map((v) => v?.trim() || undefined))

const configError = (message: string) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message }))

const parseKeyValues = (raw: string | undefined): Record<string, string> => {
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=")
    if (eq <= 0) continue
    const key = entry.slice(0, eq).trim()
    if (!key) continue
    const val = entry.slice(eq + 1).trim()
    try {
      out[key] = decodeURIComponent(val)
    } catch {
      out[key] = val
    }
  }
  return out
}

const resolveOtlpUrl = (own: string | undefined, base: string | undefined, path: string): string | undefined => {
  const raw = own ?? base
  if (!raw) return undefined
  const url = new URL(raw)
  if (own !== undefined) {
    if (url.pathname === "/") url.pathname = path
    return url.toString()
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`
  return url.toString()
}

const wantsOtlp = (raw: string | undefined): boolean =>
  raw === undefined || raw.split(",").map((s) => s.trim().toLowerCase()).includes("otlp")

export class AppConfig extends Context.Service<AppConfig, {
  readonly port: number
  readonly internalPort: number
  readonly databasePath: string
  readonly identityInternalUrl: string | undefined
  readonly taskAssigneePermission: string
  readonly appVersion: string
}>()("api/AppConfig") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const port = yield* Config.Int("PORT").pipe(Config.withDefault(3000))
      const internalPort = yield* Config.Int("INTERNAL_PORT").pipe(Config.withDefault(3001))
      const databasePath = (yield* optionalString("DATABASE_PATH")) ?? "./data/app.db"
      const rawIdentityUrl = yield* optionalTrimmed("IDENTITY_INTERNAL_URL")
      const identityInternalUrl = rawIdentityUrl?.replace(/\/+$/, "") || undefined
      const taskAssigneePermission = yield* optionalString("TASK_ASSIGNEE_PERMISSION")
      const appVersion = (yield* optionalTrimmed("APP_VERSION")) ?? "dev"

      if (taskAssigneePermission === undefined || !PERMISSION_NAME.test(taskAssigneePermission)) {
        return yield* Effect.fail(configError(
          "TASK_ASSIGNEE_PERMISSION is unset or invalid (must match [a-z0-9:._-]{1,64}, e.g. project:read)"
        ))
      }

      return AppConfig.of({
        port,
        internalPort,
        databasePath,
        identityInternalUrl,
        taskAssigneePermission,
        appVersion
      })
    })
  )
}

export const TelemetryConfig = Config.all({
  disabled: optionalTrimmed("OTEL_SDK_DISABLED").pipe(Config.map((v) => v?.toLowerCase() === "true")),
  serviceName: optionalTrimmed("OTEL_SERVICE_NAME"),
  hostname: optionalTrimmed("HOSTNAME"),
  appVersion: optionalTrimmed("APP_VERSION"),
  resourceAttributes: optionalTrimmed("OTEL_RESOURCE_ATTRIBUTES"),
  baseEndpoint: optionalTrimmed("OTEL_EXPORTER_OTLP_ENDPOINT"),
  tracesEndpoint: optionalTrimmed("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
  metricsEndpoint: optionalTrimmed("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"),
  tracesExporter: optionalTrimmed("OTEL_TRACES_EXPORTER"),
  metricsExporter: optionalTrimmed("OTEL_METRICS_EXPORTER"),
  headers: optionalTrimmed("OTEL_EXPORTER_OTLP_HEADERS"),
  tracesHeaders: optionalTrimmed("OTEL_EXPORTER_OTLP_TRACES_HEADERS"),
  metricsHeaders: optionalTrimmed("OTEL_EXPORTER_OTLP_METRICS_HEADERS"),
  tracesSamplerRatio: Config.Number("OTEL_TRACES_SAMPLER_RATIO").pipe(Config.withDefault(1)),
  metricExportIntervalMs: Config.Int("OTEL_METRIC_EXPORT_INTERVAL").pipe(Config.withDefault(60_000))
}).pipe(
  Config.map((t) => {
    const resource: Record<string, string> = {
      "service.name": "api",
      "service.namespace": "api",
      "service.instance.id": t.hostname ?? "api-local",
      "service.version": t.appVersion ?? "dev",
      "deployment.environment": "development",
      ...parseKeyValues(t.resourceAttributes)
    }
    if (t.serviceName !== undefined) resource["service.name"] = t.serviceName

    const baseHeaders = parseKeyValues(t.headers)
    return {
      resource,
      otlpTracesUrl: !t.disabled && wantsOtlp(t.tracesExporter)
        ? resolveOtlpUrl(t.tracesEndpoint, t.baseEndpoint, "/v1/traces")
        : undefined,
      otlpMetricsUrl: !t.disabled && wantsOtlp(t.metricsExporter)
        ? resolveOtlpUrl(t.metricsEndpoint, t.baseEndpoint, "/v1/metrics")
        : undefined,
      otlpTracesHeaders: { ...baseHeaders, ...parseKeyValues(t.tracesHeaders) },
      otlpMetricsHeaders: { ...baseHeaders, ...parseKeyValues(t.metricsHeaders) },
      tracesSamplerRatio: Math.min(1, Math.max(0, t.tracesSamplerRatio)),
      metricExportIntervalMs: Math.max(1, t.metricExportIntervalMs)
    }
  })
)
