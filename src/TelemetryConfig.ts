/**
 * The telemetry config (plat5 docs/reference/telemetry.md): the resource, where traces and
 * metrics go, sampling and the export interval, from the standard OTEL_* variables. A
 * variable set but invalid fails the config, naming it.
 */
import { Config, Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect"
import { VERSION } from "./Version.js"

/** `config`, or undefined when its variable is unset or empty. */
const optional = <A>(config: Config.Config<A>): Config.Config<A | undefined> =>
  Config.option(config).pipe(Config.map(Option.getOrUndefined))

/** A variable as set, untrimmed, or undefined when unset or empty. */
const text = (name: string) => optional(Config.String(name))

/** A variable trimmed, or undefined when unset or empty, or only white space. */
const trimmed = (name: string) => text(name).pipe(Config.map((value) => value?.trim() || undefined))

/** An OTLP protocol variable: only http/protobuf is supported. */
const protocol = (name: string) =>
  optional(Config.schema(Schema.Literal("http/protobuf").annotate({ message: "only http/protobuf is supported" }), name))

/**
 * A comma-separated OTEL_*_EXPORTER value, lowercased: undefined when unset or empty (the
 * default applies). A value outside `allowed` is an error.
 */
const exporters = (name: string, allowed: ReadonlyArray<string>) =>
  optional(Config.schema(
    Schema.String.pipe(
      Schema.decodeTo(
        Schema.Array(Schema.String).check(
          Schema.makeFilter((list: ReadonlyArray<string>) => list.every((exporter) => allowed.includes(exporter)), {
            message: `want a comma-separated list of ${allowed.join(", ")}`
          })
        ),
        SchemaTransformation.transform({
          decode: (raw: string): ReadonlyArray<string> =>
            raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0),
          encode: (list: ReadonlyArray<string>) => list.join(",")
        })
      )
    ),
    name
  )).pipe(Config.map((list) => (list === undefined || list.length === 0 ? undefined : list)))

/**
 * OTEL_RESOURCE_ATTRIBUTES and OTEL_EXPORTER_OTLP_*HEADERS: `key=value,…` with percent-encoded values. An entry without
 * `=` or a key is an error.
 */
const KeyValues = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Record(Schema.String, Schema.String),
    SchemaTransformation.transformEffect({
      decode: (raw: string) => {
        const out: Record<string, string> = {}
        for (const entry of raw.split(",")) {
          const eq = entry.indexOf("=")
          const key = eq >= 0 ? entry.slice(0, eq).trim() : ""
          if (!key) return Effect.fail(new SchemaIssue.InvalidValue({ message: "want key=value entries, comma-separated" }))
          try {
            out[key] = decodeURIComponent(entry.slice(eq + 1).trim())
          } catch {
            return Effect.fail(new SchemaIssue.InvalidValue({ message: "want percent-encoded values" }))
          }
        }
        return Effect.succeed(out)
      },
      encode: (attributes: Readonly<Record<string, string>>) =>
        Effect.succeed(
          Object.entries(attributes).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join(",")
        )
    })
  )
)

/** An OTLP endpoint variable: an http:// or https:// URL. */
const endpoint = (name: string) =>
  optional(Config.schema(
    Schema.URLFromString.check(
      Schema.makeFilter((url: URL) => (url.protocol === "http:" || url.protocol === "https:") && url.host !== "", {
        message: "want an http:// or https:// URL"
      })
    ),
    name
  ))

/** The variables the resource is layered from (plat5 docs/reference/telemetry.md#resource-identity). */
export type ResourceEnv = {
  readonly OTEL_SERVICE_NAME?: string | undefined
  readonly OTEL_SERVICE_NAMESPACE?: string | undefined
  readonly OTEL_SERVICE_VERSION?: string | undefined
  readonly OTEL_SERVICE_INSTANCE_ID?: string | undefined
  readonly HOSTNAME?: string | undefined
  readonly OTEL_DEPLOYMENT_ENV?: string | undefined
  readonly DEPLOYMENT_ENV?: string | undefined
  /** OTEL_RESOURCE_ATTRIBUTES, decoded. */
  readonly attributes?: Readonly<Record<string, string>> | undefined
}

/**
 * The resource, layered: the service's defaults (the build's `version` among them), then
 * OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME, then the convenience variables that are set.
 */
export const serviceResource = (env: ResourceEnv, version: string): Record<string, string> => {
  const resource: Record<string, string> = {
    "service.name": "api",
    "service.namespace": "api",
    "service.instance.id": env.HOSTNAME ?? "api-local",
    "service.version": version,
    "deployment.environment": "development",
    ...env.attributes
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

/**
 * An OTLP destination: the per-signal URL (with the signal's path when it has none), else the
 * base URL with `path`. Undefined when neither is set.
 */
const destination = (own: URL | undefined, base: URL | undefined, path: string): string | undefined => {
  if (own !== undefined) {
    const url = new URL(own)
    if (url.pathname === "/") url.pathname = path
    return url.toString()
  }
  if (base === undefined) return undefined
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`
  return url.toString()
}

/**
 * The telemetry config (plat5 docs/reference/telemetry.md). With a destination, traces and
 * metrics are both pushed unless OTEL_TRACES_EXPORTER / OTEL_METRICS_EXPORTER leave `otlp`
 * out, or OTEL_SDK_DISABLED is true. A variable set but invalid is an error naming it
 * (plat5 docs/reference/telemetry.md#invalid-values).
 */
export const TelemetryConfig = Config.all({
  disabled: Config.schema(
    Schema.String.check(Schema.makeFilter((s: string) => /^(true|false)$/i.test(s), { message: "want true or false" })),
    "OTEL_SDK_DISABLED"
  ).pipe(Config.map((s) => s.toLowerCase() === "true"), Config.withDefault(false)),
  protocols: Config.all([
    protocol("OTEL_EXPORTER_OTLP_PROTOCOL"),
    protocol("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL"),
    protocol("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL")
  ]),
  tracesExporters: exporters("OTEL_TRACES_EXPORTER", ["otlp", "none"]),
  metricsExporters: exporters("OTEL_METRICS_EXPORTER", ["otlp", "prometheus", "none"]),
  base: endpoint("OTEL_EXPORTER_OTLP_ENDPOINT"),
  traces: endpoint("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
  metrics: endpoint("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"),
  ratio: Config.schema(
    Schema.NumberFromString.check(Schema.isBetween({ minimum: 0, maximum: 1 }, { message: "want a number from 0 to 1" })),
    "OTEL_TRACES_SAMPLER_RATIO"
  ).pipe(Config.withDefault(1)),
  interval: Config.schema(
    Schema.NumberFromString.check(
      Schema.isInt({ message: "want a positive number of milliseconds" }),
      Schema.isGreaterThan(0, { message: "want a positive number of milliseconds" })
    ),
    "OTEL_METRIC_EXPORT_INTERVAL"
  ).pipe(Config.withDefault(60_000)),
  headers: optional(Config.schema(KeyValues, "OTEL_EXPORTER_OTLP_HEADERS")),
  tracesHeaders: optional(Config.schema(KeyValues, "OTEL_EXPORTER_OTLP_TRACES_HEADERS")),
  metricsHeaders: optional(Config.schema(KeyValues, "OTEL_EXPORTER_OTLP_METRICS_HEADERS")),
  resource: Config.all({
    OTEL_SERVICE_NAME: trimmed("OTEL_SERVICE_NAME"),
    OTEL_SERVICE_NAMESPACE: trimmed("OTEL_SERVICE_NAMESPACE"),
    OTEL_SERVICE_VERSION: trimmed("OTEL_SERVICE_VERSION"),
    OTEL_SERVICE_INSTANCE_ID: trimmed("OTEL_SERVICE_INSTANCE_ID"),
    HOSTNAME: trimmed("HOSTNAME"),
    OTEL_DEPLOYMENT_ENV: trimmed("OTEL_DEPLOYMENT_ENV"),
    DEPLOYMENT_ENV: trimmed("DEPLOYMENT_ENV"),
    attributes: optional(Config.schema(KeyValues, "OTEL_RESOURCE_ATTRIBUTES"))
  })
}).pipe(Config.map((t) => ({
  resource: serviceResource(t.resource, VERSION),
  otlpTracesUrl: !t.disabled && (t.tracesExporters?.includes("otlp") ?? true)
    ? destination(t.traces, t.base, "/v1/traces")
    : undefined,
  otlpMetricsUrl: !t.disabled && (t.metricsExporters?.includes("otlp") ?? true)
    ? destination(t.metrics, t.base, "/v1/metrics")
    : undefined,
  /** Headers on every trace export, a collector's auth say: the base ones, then the signal's. */
  otlpTracesHeaders: { ...t.headers, ...t.tracesHeaders },
  otlpMetricsHeaders: { ...t.headers, ...t.metricsHeaders },
  metricExportIntervalMs: t.interval,
  tracesSamplerRatio: t.ratio
})))

