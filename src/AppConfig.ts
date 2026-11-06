import { Config, ConfigError, Context, Effect, Layer } from "effect"
import { VERSION } from "./Version.js"

const optionalNonEmpty = (name: string) =>
  Config.option(Config.string(name)).pipe(
    Effect.map((opt) => (opt._tag === "Some" && opt.value.trim() !== "" ? opt.value.trim() : undefined))
  )

/** A permission's name as Plat5's roles write it. */
const PERMISSION_NAME = /^[a-z0-9:._-]{1,64}$/

/** A variable as set, untrimmed, or undefined when unset or empty. */
const optionalSet = (name: string) =>
  Config.option(Config.string(name)).pipe(
    Effect.map((opt) => (opt._tag === "Some" && opt.value !== "" ? opt.value : undefined))
  )

/** The telemetry variables, each as set (trimmed), or undefined when unset or empty. */
const TELEMETRY_VARIABLES = [
  "OTEL_SERVICE_NAME",
  "OTEL_SERVICE_NAMESPACE",
  "OTEL_SERVICE_VERSION",
  "OTEL_SERVICE_INSTANCE_ID",
  "HOSTNAME",
  "OTEL_DEPLOYMENT_ENV",
  "DEPLOYMENT_ENV",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_SDK_DISABLED",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_TRACES_SAMPLER_RATIO",
  "OTEL_METRIC_EXPORT_INTERVAL"
] as const

export type TelemetryEnv = Record<(typeof TELEMETRY_VARIABLES)[number], string | undefined>

/**
 * A comma-separated OTEL_*_EXPORTER value, lowercased: undefined when unset or empty (the
 * default applies). A value outside `allowed` is an error.
 */
const exporterList = (
  name: string,
  raw: string | undefined,
  allowed: ReadonlyArray<string>
): ReadonlyArray<string> | undefined => {
  if (raw === undefined) return undefined
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
  for (const exporter of list) {
    if (!allowed.includes(exporter)) {
      throw new Error(`${name} is "${raw}": want a comma-separated list of ${allowed.join(", ")}`)
    }
  }
  return list.length > 0 ? list : undefined
}

/**
 * OTEL_RESOURCE_ATTRIBUTES, `key=value,…` with percent-encoded values. An entry without
 * `=` or a key is an error.
 */
const parseResourceAttributes = (raw: string | undefined): Record<string, string> => {
  if (raw === undefined) return {}
  const out: Record<string, string> = {}
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=")
    const key = eq >= 0 ? entry.slice(0, eq).trim() : ""
    if (!key) throw new Error(`OTEL_RESOURCE_ATTRIBUTES is "${raw}": want key=value entries, comma-separated`)
    try {
      out[key] = decodeURIComponent(entry.slice(eq + 1).trim())
    } catch {
      throw new Error(`OTEL_RESOURCE_ATTRIBUTES is "${raw}": want percent-encoded values`)
    }
  }
  return out
}

/**
 * The resource (plat5 docs/reference/telemetry.md#resource-identity), layered: the
 * service's defaults (the build's `version` among them), then OTEL_RESOURCE_ATTRIBUTES and
 * OTEL_SERVICE_NAME, then the convenience variables that are set.
 */
export const serviceResource = (env: TelemetryEnv, version: string): Record<string, string> => {
  const resource: Record<string, string> = {
    "service.name": "api",
    "service.namespace": "api",
    "service.instance.id": env.HOSTNAME ?? "api-local",
    "service.version": version,
    "deployment.environment": "development",
    ...parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES)
  }
  if (env.OTEL_SERVICE_NAME !== undefined) resource["service.name"] = env.OTEL_SERVICE_NAME
  const convenience = [
    ["service.namespace", env.OTEL_SERVICE_NAMESPACE],
    ["service.version", env.OTEL_SERVICE_VERSION],
    ["service.instance.id", env.OTEL_SERVICE_INSTANCE_ID],
    ["deployment.environment", env.OTEL_DEPLOYMENT_ENV ?? env.DEPLOYMENT_ENV]
  ] as const
  for (const [key, value] of convenience) {
    if (value !== undefined) resource[key] = value
  }
  return resource
}

/** An OTLP endpoint variable: undefined when unset, else an http:// or https:// URL. */
const endpoint = (name: string, raw: string | undefined): URL | undefined => {
  if (raw === undefined) return undefined
  const url = URL.parse(raw)
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:") || url.host === "") {
    throw new Error(`${name} is "${raw}": want an http:// or https:// URL`)
  }
  return url
}

/**
 * An OTLP destination: the per-signal URL, else the base URL with `path`. Undefined when
 * neither is set.
 */
const otlpDestination = (
  env: TelemetryEnv,
  signal: "TRACES" | "METRICS",
  path: string
): string | undefined => {
  const name = `OTEL_EXPORTER_OTLP_${signal}_ENDPOINT` as const
  const own = endpoint(name, env[name])
  if (own !== undefined) {
    // A per-signal URL without a path gets the signal's.
    if (own.pathname === "/") own.pathname = path
    return own.toString()
  }
  const base = endpoint("OTEL_EXPORTER_OTLP_ENDPOINT", env.OTEL_EXPORTER_OTLP_ENDPOINT)
  if (base === undefined) return undefined
  base.pathname = `${base.pathname.replace(/\/$/, "")}${path}`
  return base.toString()
}

/** OTEL_SDK_DISABLED: unset or empty is false, else true or false. */
const sdkDisabled = (raw: string | undefined): boolean => {
  if (raw === undefined) return false
  const value = raw.toLowerCase()
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`OTEL_SDK_DISABLED is "${raw}": want true or false`)
}

/** OTEL_TRACES_SAMPLER_RATIO: unset is 1, else a number from 0 to 1. */
const samplerRatio = (raw: string | undefined): number => {
  if (raw === undefined) return 1
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`OTEL_TRACES_SAMPLER_RATIO is "${raw}": want a number from 0 to 1`)
  }
  return n
}

/** OTEL_METRIC_EXPORT_INTERVAL, in ms: unset is 60000, else a positive whole number. */
const metricExportInterval = (raw: string | undefined): number => {
  if (raw === undefined) return 60_000
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`OTEL_METRIC_EXPORT_INTERVAL is "${raw}": want a positive number of milliseconds`)
  }
  return n
}

/**
 * The telemetry config (plat5 docs/reference/telemetry.md). With a destination, traces and
 * metrics are both pushed unless OTEL_TRACES_EXPORTER / OTEL_METRICS_EXPORTER leave `otlp`
 * out, or OTEL_SDK_DISABLED is true. A variable set but invalid is an error naming it
 * (plat5 docs/reference/telemetry.md#invalid-values).
 */
const telemetryConfig = (env: TelemetryEnv) => {
  const disabled = sdkDisabled(env.OTEL_SDK_DISABLED)
  for (
    const name of [
      "OTEL_EXPORTER_OTLP_PROTOCOL",
      "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
      "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL"
    ] as const
  ) {
    const value = env[name]
    if (value !== undefined && value !== "http/protobuf") {
      throw new Error(`${name} is "${value}": only http/protobuf is supported`)
    }
  }
  const tracesExporters = exporterList("OTEL_TRACES_EXPORTER", env.OTEL_TRACES_EXPORTER, ["otlp", "none"])
  const metricsExporters = exporterList("OTEL_METRICS_EXPORTER", env.OTEL_METRICS_EXPORTER, [
    "otlp",
    "prometheus",
    "none"
  ])
  const resource = serviceResource(env, VERSION)
  endpoint("OTEL_EXPORTER_OTLP_ENDPOINT", env.OTEL_EXPORTER_OTLP_ENDPOINT)
  const tracesUrl = otlpDestination(env, "TRACES", "/v1/traces")
  const metricsUrl = otlpDestination(env, "METRICS", "/v1/metrics")
  return {
    resource,
    otlpTracesUrl: !disabled && (tracesExporters?.includes("otlp") ?? true) ? tracesUrl : undefined,
    otlpMetricsUrl: !disabled && (metricsExporters?.includes("otlp") ?? true) ? metricsUrl : undefined,
    metricExportIntervalMs: metricExportInterval(env.OTEL_METRIC_EXPORT_INTERVAL),
    tracesSamplerRatio: samplerRatio(env.OTEL_TRACES_SAMPLER_RATIO)
  }
}

export class AppConfig extends Context.Tag("AppConfig")<
  AppConfig,
  {
    readonly port: number
    readonly internalPort: number
    readonly databasePath: string
    /**
     * Identity's internal base URL, for its lifecycle log and the assignee check.
     * Unset: the log isn't read, and a task with an assignee is a 503.
     */
    readonly identityInternalUrl: string | undefined
    /**
     * The permission a task's assignee needs on its project: the deployment's name for it,
     * never the code's. Unset or empty, the API won't start.
     */
    readonly taskAssigneePermission: string
    /** The OpenTelemetry resource: service.name, service.version and the rest. */
    readonly resource: Readonly<Record<string, string>>
    /** Where traces go, or undefined for no OTLP traces. */
    readonly otlpTracesUrl: string | undefined
    /** Where metrics go, or undefined for no OTLP metrics. `/metrics` is on regardless. */
    readonly otlpMetricsUrl: string | undefined
    readonly metricExportIntervalMs: number
    readonly tracesSamplerRatio: number
  }
>() {
  static readonly Live = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const port = yield* Config.integer("PORT").pipe(Config.withDefault(3000))
      const internalPort = yield* Config.integer("INTERNAL_PORT").pipe(Config.withDefault(3001))
      const databasePath = (yield* optionalSet("DATABASE_PATH")) ?? "./data/app.db"
      const identityInternalUrl = yield* optionalSet("IDENTITY_INTERNAL_URL")
      const taskAssigneePermission = yield* optionalSet("TASK_ASSIGNEE_PERMISSION").pipe(
        Effect.filterOrFail(
          (value): value is string => value !== undefined && PERMISSION_NAME.test(value),
          () =>
            ConfigError.MissingData(
              ["TASK_ASSIGNEE_PERMISSION"],
              "TASK_ASSIGNEE_PERMISSION is unset or isn't a permission name ([a-z0-9:._-], at most 64 characters): set it to the permission an assignee needs on the task's project (the starter's is project:read)"
            )
        )
      )
      const env = yield* Effect.all(
        Object.fromEntries(TELEMETRY_VARIABLES.map((name) => [name, optionalNonEmpty(name)]))
      ) as Effect.Effect<TelemetryEnv, ConfigError.ConfigError>
      const telemetry = yield* Effect.try({
        try: () => telemetryConfig(env),
        catch: (err) => ConfigError.InvalidData([], err instanceof Error ? err.message : String(err))
      })

      return {
        port,
        internalPort,
        databasePath,
        identityInternalUrl,
        taskAssigneePermission,
        ...telemetry
      } as const
    })
  )
}
