import { expect, onTestFinished, test } from "bun:test"
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { AppConfig } from "./Config.js"
import { InternalRoutes } from "./InternalHttp.js"
import { SqlLive } from "./Sql.js"
import { envLayer, makeTestApp } from "./testing.js"

const makeInternalApp = () => {
  const layer = InternalRoutes.pipe(
    Layer.provideMerge(SqlLive),
    Layer.provide([HttpServer.layerServices, AppConfig.layer]),
    Layer.provide(envLayer({ DATABASE_PATH: ":memory:" }))
  )
  const app = HttpRouter.toWebHandler(layer, { disableLogger: true })
  onTestFinished(() => app.dispose())
  return (path: string, method = "GET") => app.handler(new Request(`http://internal.test${path}`, { method }))
}

test("health: /health/live and /health/ready return 200 healthy", async () => {
  const internal = makeInternalApp()
  for (const path of ["/health/live", "/health/ready"]) {
    const res = await internal(path)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/json")
    expect(await res.json()).toEqual({ status: "healthy" })
  }
})

test("unknown internal routes return the 404 envelope", async () => {
  const internal = makeInternalApp()
  for (const [path, method] of [["/nope", "GET"], ["/health/live", "POST"], ["/metrics", "DELETE"]] as const) {
    const res = await internal(path, method)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND")
  }
})

test("/metrics exposes HTTP request counters, latency histograms, and process metrics", async () => {
  const pub = makeTestApp()
  const internal = makeInternalApp()

  await pub.fetch("/projects/01jd8x3k7q0000000000000000/tasks")
  await pub.fetch("/nope")

  const res = await internal("/metrics")
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toContain("# HELP http_requests_total Total HTTP requests handled by the api service")
  expect(text).toContain("# HELP http_request_duration_seconds HTTP request latency observed by the api service")
  expect(text).toMatch(/http_requests_total\{[^}]*route="\/projects\/:project_id\/tasks"/)
  expect(text).toMatch(/http_requests_total\{[^}]*route="unknown"/)
  for (const name of ["process_resident_memory_bytes", "process_cpu_seconds_total", "process_start_time_seconds"]) {
    expect(text).toMatch(new RegExp(`^${name} [0-9.e+]+$`, "m"))
  }
})
