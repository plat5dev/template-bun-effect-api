import { BunHttpServer } from "@effect/platform-bun"
import { expect, onTestFinished, spyOn, test } from "bun:test"
import { Context, Effect, Exit, Layer, Scope, Tracer } from "effect"
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { HttpErrors, NotFound, ServiceUnavailable } from "./Errors.js"
import { httpObservability } from "./HttpObservability.js"
import * as Log from "./Log.js"
import { Plat5Request } from "./Request.js"

class Boom extends HttpApiGroup.make("boom").add(
  HttpApiEndpoint.get("ok", "/ok"),
  HttpApiEndpoint.get("missing", "/missing", { error: HttpErrors.NotFound }),
  HttpApiEndpoint.get("die", "/die"),
  HttpApiEndpoint.get("unavailable", "/unavailable", { error: HttpErrors.ServiceUnavailable })
).middleware(Plat5Request) {}
class TestApi extends HttpApi.make("test").add(Boom) {}

const BoomLive = HttpApiBuilder.group(TestApi, "boom", (handlers) =>
  handlers
    .handle("ok", () => Effect.void)
    .handle("missing", () => Effect.fail(new NotFound({ resource: "node", id: "n1" })))
    .handle("die", () => Effect.die(new Error("SQLITE_BUSY: database is locked at /data/app.db")))
    .handle("unavailable", () => Effect.fail(new ServiceUnavailable()))).pipe(Layer.provide(Plat5Request.layer))

/** An API whose routes fail, behind the middleware, its spans recorded. */
const serve = async () => {
  // Every span, as Effect's own tracer makes it.
  const recorded: Array<Tracer.Span> = []
  const tracer = Tracer.make({
    span: (options) => {
      const span = Tracer.nativeTracer.span(options)
      recorded.push(span)
      return span
    }
  })
  const logs = spyOn(console, "log").mockImplementation(() => {})
  const scope = Effect.runSync(Scope.make())
  onTestFinished(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    logs.mockRestore()
  })
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      HttpRouter.serve(HttpApiBuilder.layer(TestApi).pipe(Layer.provide(BoomLive)), {
        middleware: httpObservability(TestApi),
        disableLogger: true,
        disableListenLog: true
      }).pipe(
        Layer.provide(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true)),
        Layer.provideMerge(BunHttpServer.layer({ port: 0, hostname: "127.0.0.1" })),
        Layer.provide([Layer.succeed(Tracer.Tracer, tracer), Log.layer])
      ),
      scope
    )
  )
  const { address } = Context.get(context, HttpServer.HttpServer)
  const base = `http://127.0.0.1:${"port" in address ? address.port : 0}`
  const lines = () =>
    logs.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((line) => line.message === "request completed")
  const spans = () =>
    recorded
      .filter((span) => span.kind === "server" && span.status._tag === "Ended")
      .map((span) => ({
        attributes: Object.fromEntries(span.attributes),
        failed: span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
      }))
  return { base, lines, spans }
}

test("an unexpected error is the fallback 500, never its own text", async () => {
  const { base, lines } = await serve()
  const res = await fetch(`${base}/die`, { headers: { "x-request-id": "req-5" } })
  expect(res.status).toBe(500)
  expect(res.headers.get("content-type")).toBe("application/json")
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
    error_type: "internal",
    error_message: "INTERNAL_ERROR: An unexpected error occurred."
  })
})
