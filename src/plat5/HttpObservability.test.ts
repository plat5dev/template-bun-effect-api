import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpServer } from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { expect, onTestFinished, spyOn, test } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { ServiceUnavailable, serviceUnavailable } from "./Errors.js"
import { httpObservability } from "./HttpObservability.js"

class Boom extends HttpApiGroup.make("boom")
  .add(HttpApiEndpoint.get("die", "/die"))
  .add(HttpApiEndpoint.get("unavailable", "/unavailable").addError(ServiceUnavailable))
{}
class TestApi extends HttpApi.make("test").add(Boom) {}

const BoomLive = HttpApiBuilder.group(TestApi, "boom", (handlers) =>
  handlers
    .handle("die", () => Effect.die(new Error("SQLITE_BUSY: database is locked at /data/app.db")))
    .handle("unavailable", () => Effect.fail(serviceUnavailable())))

/** An API whose routes fail, behind the middleware. */
const serve = async () => {
  const logs = spyOn(console, "log").mockImplementation(() => {})
  const scope = Effect.runSync(Scope.make())
  onTestFinished(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    logs.mockRestore()
  })
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      HttpApiBuilder.serve(httpObservability(TestApi)).pipe(
        Layer.provide(HttpApiBuilder.api(TestApi).pipe(Layer.provide(BoomLive))),
        Layer.provideMerge(BunHttpServer.layer({ port: 0, hostname: "127.0.0.1" }))
      ),
      scope
    )
  )
  const { address } = Context.get(context, HttpServer.HttpServer)
  const base = `http://127.0.0.1:${address._tag === "TcpAddress" ? address.port : 0}`
  const lines = () =>
    logs.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((line) => line.message === "request completed")
  return { base, lines }
}

test("an unexpected error is the fallback 500, never its own text", async () => {
  const { base, lines } = await serve()
  const res = await fetch(`${base}/die`, { headers: { "x-request-id": "req-5" } })
  expect(res.status).toBe(500)
  expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8")
  expect(await res.json()).toEqual({
    error: {
      type: "api_error",
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
      request_id: "req-5",
      details: null
    }
  })
  expect(lines()[0]).toMatchObject({
    level: "error",
    route: "/die",
    error_kind: "internal",
    error_message: "INTERNAL_ERROR: An unexpected error occurred."
  })
})

test("a 503 is logged as the network's", async () => {
  const { base, lines } = await serve()
  const res = await fetch(`${base}/unavailable`)
  expect(res.status).toBe(503)
  expect(lines()[0]).toMatchObject({
    level: "error",
    error_kind: "network",
    error_message: "SERVICE_UNAVAILABLE: Service temporarily unavailable."
  })
})
