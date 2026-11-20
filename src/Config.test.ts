import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { AppConfig, TelemetryConfig } from "./Config.js"
import { envLayer } from "./testing.js"

const loadApp = (env: Record<string, string>) =>
  Effect.runPromiseExit(
    Effect.service(AppConfig).pipe(Effect.provide(AppConfig.layer), Effect.provide(envLayer(env)))
  )

const loadTelemetry = (env: Record<string, string>) =>
  Effect.runPromise(Effect.gen(function*() {
    return yield* TelemetryConfig
  }).pipe(Effect.provide(envLayer(env))))

test("AppConfig defaults, trims IDENTITY_INTERNAL_URL trailing slash, and reads APP_VERSION", async () => {
  const exit = await loadApp({
    IDENTITY_INTERNAL_URL: "http://identity:3001///",
    DATABASE_PATH: "",
    APP_VERSION: "v1.2.3"
  })
  if (!Exit.isSuccess(exit)) throw new Error(String(exit))
  expect(exit.value).toEqual({
    port: 3000,
    internalPort: 3001,
    databasePath: "./data/app.db",
    identityInternalUrl: "http://identity:3001",
    appVersion: "v1.2.3"
  })
})

test("TelemetryConfig defaults, OTLP URLs, exporters, headers, and resource attributes", async () => {
  const defaults = await loadTelemetry({})
  expect(defaults.otlpTracesUrl).toBeUndefined()
  expect(defaults.otlpMetricsUrl).toBeUndefined()
  expect(defaults.resource).toEqual({
    "service.name": "api",
    "service.namespace": "api",
    "service.instance.id": "api-local",
    "service.version": "dev",
    "deployment.environment": "development"
  })

  const pushed = await loadTelemetry({
    APP_VERSION: "v2.0.0",
    OTEL_SERVICE_NAME: "tasks-api",
    OTEL_RESOURCE_ATTRIBUTES: "service.namespace=edge,team=a%20b",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
    OTEL_EXPORTER_OTLP_HEADERS: "x-auth=s%20t",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-signal=traces",
    OTEL_METRICS_EXPORTER: "prometheus"
  })
  expect(pushed.otlpTracesUrl).toBe("http://collector:4318/v1/traces")
  expect(pushed.otlpMetricsUrl).toBeUndefined()
  expect(pushed.otlpTracesHeaders).toEqual({ "x-auth": "s t", "x-signal": "traces" })
  expect(pushed.resource).toMatchObject({
    "service.name": "tasks-api",
    "service.namespace": "edge",
    "service.version": "v2.0.0",
    team: "a b"
  })

  const disabled = await loadTelemetry({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    OTEL_SDK_DISABLED: "true"
  })
  expect(disabled.otlpTracesUrl).toBeUndefined()
  expect(disabled.otlpMetricsUrl).toBeUndefined()
})
