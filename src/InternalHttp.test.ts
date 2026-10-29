import { HttpApp, HttpServer } from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { SqlClient } from "@effect/sql"
import { expect, onTestFinished, spyOn, test } from "bun:test"
import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect"
import { PublicApiLive } from "./Http.js"
import { InternalApp } from "./InternalHttp.js"
import { SqlLive } from "./Sql.js"
import { MetricsScrape, TelemetryLive } from "./Telemetry.js"

/** The public API on a port, and the internal app as a fetch handler beside it. */
const serve = async () => {
  const logs = spyOn(console, "log").mockImplementation(() => {})
  const scope = Effect.runSync(Scope.make())
  onTestFinished(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    logs.mockRestore()
  })
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      PublicApiLive.pipe(
        Layer.provideMerge(BunHttpServer.layer({ port: 0, hostname: "127.0.0.1" })),
        Layer.provideMerge(TelemetryLive),
        Layer.provideMerge(SqlLive)
      ),
      scope
    ).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["DATABASE_PATH", ":memory:"], ["TASK_ASSIGNEE_PERMISSION", "x"]]))
      )
    )
  )
  const { address } = Context.get(context, HttpServer.HttpServer)
  const base = `http://127.0.0.1:${address._tag === "TcpAddress" ? address.port : 0}`
  const runtime = await Effect.runPromise(
    Effect.runtime<SqlClient.SqlClient | MetricsScrape>().pipe(Effect.provide(context))
  )
  const internal = HttpApp.toWebHandlerRuntime(runtime)(InternalApp)
  return { base, internal: (path: string, method = "GET") => internal(new Request(`http://internal${path}`, { method })) }
}

test("health: live, and ready when the database answers", async () => {
  const { internal } = await serve()
  for (const path of ["/health/live", "/health/ready"]) {
    const res = await internal(path)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(await res.json()).toEqual({ status: "healthy" })
  }
})

test("the internal port answers anything else with the 404 envelope", async () => {
  const { internal } = await serve()
  for (const [path, method] of [["/nope", "GET"], ["/health/live", "POST"], ["/metrics", "DELETE"]] as const) {
    const res = await internal(path, method)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND")
  }
})

test("metrics: names, help, and labels as the other starters have them", async () => {
  const { base, internal } = await serve()
  await fetch(`${base}/environments/01jd8x3k7q0000000000000000/tasks`)
  await fetch(`${base}/nope`)
  const text = await (await internal("/metrics")).text()
  expect(text).toContain("# HELP http_requests_total Total HTTP requests handled by the api service")
  expect(text).toContain("# HELP http_request_duration_seconds HTTP request latency observed by the api service")
  expect(text).toMatch(/http_requests_total\{[^}]*route="\/environments\/:environment_id\/tasks"/)
  expect(text).toMatch(/http_requests_total\{[^}]*route="unknown"/)
  expect(text).toMatch(/db_operations_total\{[^}]*db_operation_name="tasks\.list"[^}]*\}/)
  expect(text).toMatch(/db_operations_total\{[^}]*db_namespace="api"/)
  expect(text).not.toContain('db_namespace="app"')
})
