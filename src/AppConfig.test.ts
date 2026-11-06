import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Exit } from "effect"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { AppConfig } from "./AppConfig.js"

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
  expect(config.serviceName).toBe("api")
  expect(config.serviceVersion).toBe("0.0.0")
  expect(config.serviceInstanceId).toBe("api-local")
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

test("telemetry: a variable set but invalid is a config error", async () => {
  for (
    const [name, value] of [
      ["OTEL_SDK_DISABLED", "yes"],
      ["OTEL_EXPORTER_OTLP_PROTOCOL", "grpc"],
      ["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "http/json"],
      ["OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "grpc"],
      ["OTEL_TRACES_EXPORTER", "zipkin"],
      ["OTEL_METRICS_EXPORTER", "console"],
      ["OTEL_TRACES_SAMPLER_RATIO", "1.5"],
      ["OTEL_METRIC_EXPORT_INTERVAL", "30s"],
      ["OTEL_EXPORTER_OTLP_ENDPOINT", "collector:4318"],
      ["OTEL_RESOURCE_ATTRIBUTES", "service.version"]
    ] as const
  ) {
    const exit = await load({ TASK_ASSIGNEE_PERMISSION: "project:read", [name]: value })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain(name)
  }
})
