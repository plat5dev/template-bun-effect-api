import { expect, onTestFinished, spyOn, test } from "bun:test"
import { Effect, Exit, Layer, Tracer } from "effect"
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { makeTestApp } from "../testing.js"
import { HttpErrors, NotFound, ServiceUnavailable } from "./Errors.js"
import { catchDefectsLayer, httpObservability, redactQuery } from "./HttpObservability.js"
import * as Log from "./Log.js"

class Probe extends HttpApiGroup.make("probe").add(
  HttpApiEndpoint.get("ok", "/ok"),
  HttpApiEndpoint.get("missing", "/missing", { error: HttpErrors.NotFound }),
  HttpApiEndpoint.get("die", "/die"),
  HttpApiEndpoint.get("unavailable", "/unavailable", { error: HttpErrors.ServiceUnavailable })
) {}
class TestApi extends HttpApi.make("test").add(Probe) {}

const ProbeLive = HttpApiBuilder.group(TestApi, "probe", (handlers) =>
  handlers
    .handle("ok", () => Effect.logInfo("inside handler", { ok: true }, 42))
    .handle("missing", () => Effect.fail(new NotFound({ resource: "node", id: "n1" })))
    .handle("die", () => Effect.die(new Error("SQLITE_BUSY: database is locked at /data/app.db")))
    .handle("unavailable", () => Effect.fail(new ServiceUnavailable()))
)

const makeProbeApp = () => {
  const recorded: Array<Tracer.Span> = []
  const tracer = Tracer.make({
    span: (options) => {
      const span = Tracer.nativeTracer.span(options)
      recorded.push(span)
      return span
    }
  })
  const logs = spyOn(console, "log").mockImplementation(() => {})

  const AppLayer = Layer.mergeAll(catchDefectsLayer, HttpApiBuilder.layer(TestApi)).pipe(
    Layer.provide([ProbeLive, HttpServer.layerServices]),
    Layer.provideMerge(Layer.succeed(Tracer.Tracer, tracer)),
    Layer.provideMerge(Log.layer),
    Layer.provideMerge(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true))
  )

  const app = HttpRouter.toWebHandler(AppLayer, {
    middleware: httpObservability(TestApi),
    disableLogger: true
  })

  onTestFinished(async () => {
    await app.dispose()
    logs.mockRestore()
  })

  const lines = () =>
    logs.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)

  const spans = () =>
    recorded
      .filter((span) => span.kind === "server" && span.status._tag === "Ended")
      .map((span) => ({
        name: span.name,
        attributes: Object.fromEntries(span.attributes),
        failed: span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
      }))

  return {
    fetch: (path: string, headers?: Record<string, string>) =>
      app.handler(new Request(`http://api.test${path}`, { headers })),
    lines,
    spans
  }
}

test("unexpected defects return 500 envelope, mark span failed, and log with trace_id/span_id/request_id", async () => {
  const probe = makeProbeApp()
  const res = await probe.fetch("/die", { "x-request-id": "req-5" })
  expect(res.status).toBe(500)
  expect(await res.json()).toEqual({
    error: {
      type: "api_error",
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
      request_id: "req-5",
      details: null
    }
  })

  const allLogs = probe.lines()
  const unexpected = allLogs.find((l) => l.message === "unexpected error")
  const completed = allLogs.find((l) => l.message === "request completed")
  expect(unexpected).toMatchObject({ level: "error", request_id: "req-5" })
  expect(typeof unexpected?.trace_id).toBe("string")
  expect(typeof unexpected?.span_id).toBe("string")
  expect(completed).toMatchObject({
    level: "error",
    route: "/die",
    request_id: "req-5",
    error_type: "internal",
    error_message: "INTERNAL_ERROR: An unexpected error occurred."
  })
  expect(probe.spans()[0]?.failed).toBe(true)
})

test("all logs inside a span include trace_id, span_id, and format non-string messages; 4xx does not fail span", async () => {
  const probe = makeProbeApp()
  expect((await probe.fetch("/ok?sig=secret&limit=5", { "x-request-id": "req-ok" })).status).toBe(204)
  expect((await probe.fetch("/missing")).status).toBe(404)
  expect((await probe.fetch("/unavailable")).status).toBe(503)

  const handlerLog = probe.lines().find((l) => String(l.message).startsWith("inside handler"))
  expect(handlerLog?.message).toBe('inside handler {"ok":true} 42')
  expect(handlerLog?.request_id).toBe("req-ok")
  expect(typeof handlerLog?.trace_id).toBe("string")
  expect(typeof handlerLog?.span_id).toBe("string")

  const [okSpan, missingSpan, unavailableSpan] = probe.spans()
  expect(okSpan?.failed).toBe(false)
  expect(okSpan?.attributes["url.query"]).toBe("sig=REDACTED&limit=5")
  expect(missingSpan?.failed).toBe(false)
  expect(unavailableSpan?.failed).toBe(true)
  expect(unavailableSpan?.attributes["error.type"]).toBe("network")
})

test("/docs and /openapi.json log their own route names instead of unknown", async () => {
  const app = makeTestApp()
  expect((await app.fetch("/openapi.json")).status).toBe(200)
  expect((await app.fetch("/docs")).status).toBe(200)

  const routes = app.logged()
    .filter((l) => l.message === "request completed")
    .map((l) => l.route)
  expect(routes).toEqual(["/openapi.json", "/docs"])
})

test("redactQuery redacts presigned query keys and preserves others", () => {
  expect(redactQuery("limit=10&X-Amz-Signature=abc123&sig=xyz&starting_after=01")).toBe(
    "limit=10&X-Amz-Signature=REDACTED&sig=REDACTED&starting_after=01"
  )
})
