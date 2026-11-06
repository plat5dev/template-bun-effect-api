import { expect, test } from "bun:test"
import { Cause, ConfigProvider, Effect, Exit } from "effect"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { AppConfig, serviceResource, type TelemetryEnv } from "./AppConfig.js"

const missing =
  "TASK_ASSIGNEE_PERMISSION is unset or isn't a permission name ([a-z0-9:._-], at most 64 characters): set it to the permission an assignee needs on the task's project (the starter's is project:read)"

/** The config, read from `env` alone. */
const load = (env: Record<string, string>) =>
  Effect.runPromiseExit(
    AppConfig.pipe(
      Effect.provide(AppConfig.Live),
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(env))))
    )
  )

test("TASK_ASSIGNEE_PERMISSION unset or not a permission name: the config fails", async () => {
  for (const env of [
    {},
    { TASK_ASSIGNEE_PERMISSION: "" },
    { TASK_ASSIGNEE_PERMISSION: "  " },
    { TASK_ASSIGNEE_PERMISSION: " tasks:assignable " },
    { TASK_ASSIGNEE_PERMISSION: "Project:Read" },
    { TASK_ASSIGNEE_PERMISSION: "a".repeat(65) }
  ] as Record<string, string>[]) {
    const exit = await load(env)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain(missing)
  }
})

test("TASK_ASSIGNEE_PERMISSION names the assignee's permission", async () => {
  const exit = await load({ TASK_ASSIGNEE_PERMISSION: "tasks:assignable" })
  expect(Exit.isSuccess(exit) && exit.value.taskAssigneePermission).toBe("tasks:assignable")
})

test("variables are read as set: only unset or empty is unset", async () => {
  const exit = await load({
    TASK_ASSIGNEE_PERMISSION: "tasks:assignable",
    IDENTITY_INTERNAL_URL: "",
    DATABASE_PATH: ""
  })
  if (!Exit.isSuccess(exit)) throw new Error(String(exit))
  expect(exit.value.taskAssigneePermission).toBe("tasks:assignable")
  expect(exit.value.identityInternalUrl).toBeUndefined()
  expect(exit.value.databasePath).toBe("./data/app.db")
})

test("without TASK_ASSIGNEE_PERMISSION the API won't start", () => {
  const main = fileURLToPath(new URL("./main.ts", import.meta.url))
  // Out of the repo, so no .env sets it.
  const run = Bun.spawnSync([process.execPath, main], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "", TASK_ASSIGNEE_PERMISSION: "" }
  })
  expect(run.exitCode).toBe(1)
  expect(`${run.stdout}${run.stderr}`).toContain(missing)
})

/** The config from `env` and the permission. */
const loadOk = async (env: Record<string, string>) => {
  const exit = await load({ TASK_ASSIGNEE_PERMISSION: "project:read", ...env })
  if (!Exit.isSuccess(exit)) throw new Error(String(exit))
  return exit.value
}

test("telemetry defaults: no OTLP without an endpoint", async () => {
  const config = await loadOk({})
  expect(config.otlpTracesUrl).toBeUndefined()
  expect(config.otlpMetricsUrl).toBeUndefined()
  expect(config.resource).toEqual({
    "service.name": "api",
    "service.namespace": "api",
    "service.instance.id": "api-local",
    "service.version": "dev",
    "deployment.environment": "development"
  })
  expect(config.tracesSamplerRatio).toBe(1)
  expect(config.metricExportIntervalMs).toBe(60_000)
})

test("telemetry defaults: an endpoint pushes traces and metrics", async () => {
  const config = await loadOk({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" })
  expect(config.otlpTracesUrl).toBe("http://collector:4318/v1/traces")
  expect(config.otlpMetricsUrl).toBe("http://collector:4318/v1/metrics")
})

test("telemetry: the exporters and OTEL_SDK_DISABLED turn a signal's push off", async () => {
  const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }
  const scrape = await loadOk({ ...endpoint, OTEL_METRICS_EXPORTER: "prometheus" })
  expect(scrape.otlpTracesUrl).toBe("http://collector:4318/v1/traces")
  expect(scrape.otlpMetricsUrl).toBeUndefined()
  expect((await loadOk({ ...endpoint, OTEL_TRACES_EXPORTER: "none" })).otlpTracesUrl).toBeUndefined()
  const disabled = await loadOk({ ...endpoint, OTEL_SDK_DISABLED: "true" })
  expect(disabled.otlpTracesUrl).toBeUndefined()
  expect(disabled.otlpMetricsUrl).toBeUndefined()
  const own = await loadOk({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example" })
  expect(own.otlpTracesUrl).toBe("https://traces.example/v1/traces")
  expect(own.otlpMetricsUrl).toBeUndefined()
})

// Each set-but-invalid value in telemetry.md's "Invalid values" table stops the API at
// boot, with an error naming the variable.
test("telemetry: a variable set but invalid is a config error naming it", async () => {
  for (
    const [name, value] of [
      ["OTEL_TRACES_EXPORTER", "jaeger"],
      ["OTEL_TRACES_EXPORTER", "otlp,prometheus"],
      ["OTEL_METRICS_EXPORTER", "otlp,statsd"],
      ["OTEL_EXPORTER_OTLP_PROTOCOL", "grpc"],
      ["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "http/json"],
      ["OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "grpc"],
      ["OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4318"],
      ["OTEL_EXPORTER_OTLP_ENDPOINT", "grpc://collector:4317"],
      ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "ftp://collector/v1/traces"],
      ["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "collector"],
      ["OTEL_TRACES_SAMPLER_RATIO", "1.5"],
      ["OTEL_TRACES_SAMPLER_RATIO", "-0.1"],
      ["OTEL_TRACES_SAMPLER_RATIO", "half"],
      ["OTEL_METRIC_EXPORT_INTERVAL", "0"],
      ["OTEL_METRIC_EXPORT_INTERVAL", "10s"],
      ["OTEL_SDK_DISABLED", "yes"],
      ["OTEL_RESOURCE_ATTRIBUTES", "service.namespace"],
      ["OTEL_RESOURCE_ATTRIBUTES", "a=b,=c"]
    ] as const
  ) {
    const exit = await load({ TASK_ASSIGNEE_PERMISSION: "project:read", [name]: value })
    if (!Exit.isFailure(exit)) throw new Error(`${name}=${value} accepted`)
    expect(Cause.pretty(exit.cause)).toContain(`${name} is "${value}"`)
  }
})

test("telemetry: valid values are accepted", async () => {
  await loadOk({
    OTEL_TRACES_EXPORTER: "otlp,none",
    OTEL_METRICS_EXPORTER: "prometheus,none",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
    OTEL_TRACES_SAMPLER_RATIO: "0.25",
    OTEL_METRIC_EXPORT_INTERVAL: "5000",
    OTEL_SDK_DISABLED: "true",
    OTEL_RESOURCE_ATTRIBUTES: "service.namespace=edge,deployment.environment=dev",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ""
  })
})

test("an invalid telemetry value stops the API at boot, naming the variable", () => {
  const main = fileURLToPath(new URL("./main.ts", import.meta.url))
  const run = Bun.spawnSync([process.execPath, main], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "", TASK_ASSIGNEE_PERMISSION: "project:read", OTEL_TRACES_SAMPLER_RATIO: "2" }
  })
  expect(run.exitCode).toBe(1)
  expect(`${run.stdout}${run.stderr}`).toContain(`OTEL_TRACES_SAMPLER_RATIO is "2"`)
})

const telemetryEnv = (env: Partial<TelemetryEnv>) => env as TelemetryEnv

// service.version: OTEL_SERVICE_VERSION, then OTEL_RESOURCE_ATTRIBUTES, then the build's
// VERSION, which is dev without one. CI_COMMIT_TAG plays no part.
test("service.version: the build's VERSION, else dev; the variables override it", async () => {
  const ci = { CI_COMMIT_TAG: "v9.9.9" }
  expect((await loadOk(ci)).resource["service.version"]).toBe("dev")
  expect(serviceResource(telemetryEnv({}), "v1.2.3")["service.version"]).toBe("v1.2.3")
  const bag = { OTEL_RESOURCE_ATTRIBUTES: "service.version=v2.0.0" }
  expect(serviceResource(telemetryEnv(bag), "v1.2.3")["service.version"]).toBe("v2.0.0")
  expect((await loadOk({ ...ci, ...bag })).resource["service.version"]).toBe("v2.0.0")
  const own = { ...bag, OTEL_SERVICE_VERSION: "v3.0.0" }
  expect(serviceResource(telemetryEnv(own), "v1.2.3")["service.version"]).toBe("v3.0.0")
  expect((await loadOk({ ...ci, ...own })).resource["service.version"]).toBe("v3.0.0")
})

test("the resource: defaults, then OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME, then the convenience variables", async () => {
  const bag = await loadOk({
    HOSTNAME: "host-1",
    OTEL_RESOURCE_ATTRIBUTES: "service.name=bag,service.namespace=edge,service.instance.id=i-1,team=a%20b"
  })
  expect(bag.resource).toMatchObject({
    "service.name": "bag",
    "service.namespace": "edge",
    "service.instance.id": "i-1",
    "deployment.environment": "development",
    team: "a b"
  })
  const vars = await loadOk({
    OTEL_RESOURCE_ATTRIBUTES: "service.name=bag,service.namespace=edge,deployment.environment=bag",
    OTEL_SERVICE_NAME: "named",
    OTEL_SERVICE_NAMESPACE: "ns",
    OTEL_SERVICE_INSTANCE_ID: "i-2",
    DEPLOYMENT_ENV: "staging"
  })
  expect(vars.resource).toMatchObject({
    "service.name": "named",
    "service.namespace": "ns",
    "service.instance.id": "i-2",
    "deployment.environment": "staging"
  })
  expect((await loadOk({ DEPLOYMENT_ENV: "staging", OTEL_DEPLOYMENT_ENV: "prod" })).resource["deployment.environment"])
    .toBe("prod")
})
