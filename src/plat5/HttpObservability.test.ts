import { BunHttpServer } from "@effect/platform-bun"
import { expect, onTestFinished, spyOn, test } from "bun:test"
import { Context, Effect, Exit, Layer, Scope, Tracer } from "effect"
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { HttpErrors, NotFound, ServiceUnavailable } from "./Errors.js"
import { httpObservability } from "./HttpObservability.js"
import { redactQuery } from "./Redact.js"
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

test("a 503 is logged as the network's", async () => {
  const { base, lines } = await serve()
  const res = await fetch(`${base}/unavailable`)
  expect(res.status).toBe(503)
  expect(lines()[0]).toMatchObject({
    level: "error",
    error_type: "network",
    error_message: "SERVICE_UNAVAILABLE: Service temporarily unavailable."
  })
})

test("redactQuery: the listed keys' values are REDACTED, exactly as named", () => {
  const cases: Record<string, string> = {
    "a=1&b=2": "a=1&b=2",
    "sig=abc&a=1": "sig=REDACTED&a=1",
    "X-Amz-Signature=x&X-Amz-Credential=y&X-Amz-Security-Token=z":
      "X-Amz-Signature=REDACTED&X-Amz-Credential=REDACTED&X-Amz-Security-Token=REDACTED",
    "Signature=s&AWSAccessKeyId=k&X-Goog-Signature=g":
      "Signature=REDACTED&AWSAccessKeyId=REDACTED&X-Goog-Signature=REDACTED",
    "SIG=abc&sig": "SIG=abc&sig",
    "q=a%20b+c&sig=": "q=a%20b+c&sig=REDACTED"
  }
  for (const [query, want] of Object.entries(cases)) expect(redactQuery(query)).toBe(want)
})

test("the HTTP server span has url.scheme and the redacted url.query", async () => {
  const { base, spans } = await serve()
  await fetch(`${base}/ok?sig=secret&page=2&X-Amz-Signature=s3`)
  const [span] = spans()
  expect(span?.attributes).toMatchObject({
    "url.scheme": "http",
    "url.path": "/ok",
    "url.query": "sig=REDACTED&page=2&X-Amz-Signature=REDACTED"
  })
  expect(span?.attributes["url.full"]).toBeUndefined()
})

test("a 2xx span isn't an error", async () => {
  const { base, spans } = await serve()
  await fetch(`${base}/ok`)
  expect(spans()[0]?.failed).toBe(false)
})

test("a request without a query has no url.query", async () => {
  const { base, spans } = await serve()
  await fetch(`${base}/ok`)
  await fetch(`${base}/ok?`)
  expect(spans()).toHaveLength(2)
  for (const span of spans()) expect(span.attributes).not.toHaveProperty("url.query")
})

test("error.type and error_type on a 5xx only", async () => {
  const { base, lines, spans } = await serve()
  expect((await fetch(`${base}/die`)).status).toBe(500)
  expect((await fetch(`${base}/missing`)).status).toBe(404)
  const [broken, missing] = spans()
  const [brokenLine, missingLine] = lines()

  expect(broken?.attributes["error.type"]).toBe("internal")
  expect(broken?.failed).toBe(true) // Error
  expect(brokenLine).toMatchObject({ error_type: "internal" })
  expect(brokenLine).not.toHaveProperty("error_kind")

  expect(missing?.attributes).not.toHaveProperty("error.type")
  expect(missing?.failed).toBe(false) // never Error on a 4xx
  expect(missingLine).not.toHaveProperty("error_type")
})
