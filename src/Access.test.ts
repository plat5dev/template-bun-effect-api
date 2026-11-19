import { expect, onTestFinished, spyOn, test } from "bun:test"
import { Effect, Layer, Result, Tracer } from "effect"
import { FetchHttpClient, HttpServerRequest } from "effect/http"
import { Access, type Question } from "./Access.js"
import { AppConfig } from "./Config.js"
import * as Log from "./plat5/Log.js"
import { envLayer } from "./testing.js"

const member = "01jd8x3k7q00000000000000mm"
const project = "01jd8x3k7q00000000000000pp"
const question: Question = {
  memberId: member,
  kind: "project",
  nodeId: project,
  permission: "project:read"
}

const serveIdentity = (status: number, body: string) => {
  const got: { headers?: Headers; body?: unknown } = {}
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/access/v1/evaluation") {
        return new Response(null, { status: 404 })
      }
      got.headers = req.headers
      got.body = await req.json()
      return new Response(body, { status, headers: { "content-type": "application/json" } })
    }
  })
  onTestFinished(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, got }
}

const evaluate = (identityUrl: string | undefined, requestId: string, parent?: Tracer.AnySpan) => {
  const config: Record<string, string> = { TASK_ASSIGNEE_PERMISSION: "project:read" }
  if (identityUrl !== undefined) config.IDENTITY_INTERNAL_URL = identityUrl
  const request = HttpServerRequest.fromWeb(new Request("http://api/", { headers: { "x-request-id": requestId } }))
  const ask = Effect.flatMap(Access, (access) => access.evaluate(question)).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request)
  )
  const accessLayer = Access.layer.pipe(
    Layer.provide([AppConfig.layer, FetchHttpClient.layer]),
    Layer.provide(envLayer(config))
  )
  return Effect.runPromise(
    (parent ? Effect.withParentSpan(ask, parent) : ask).pipe(
      Effect.result,
      Effect.provide([accessLayer, Log.layer])
    )
  )
}

for (const decision of [true, false]) {
  test(`evaluate asks identity (trimming trailing slash) and answers ${decision}`, async () => {
    const identity = serveIdentity(200, JSON.stringify({ decision }))
    const parent = Tracer.externalSpan({
      traceId: "01000000000000000000000000000000",
      spanId: "0200000000000000"
    })

    expect(await evaluate(`${identity.url}/`, "req-1", parent)).toEqual(Result.succeed(decision))
    expect(identity.got.body).toEqual({
      subject: { type: "member", id: member },
      resource: { type: "project", id: project },
      action: { name: "project:read" }
    })
    expect(identity.got.headers?.get("x-request-id")).toBe("req-1")
    expect(identity.got.headers?.get("traceparent")).toMatch(/^00-01000000000000000000000000000000-[0-9a-f]{16}-01$/)
  })
}

for (const [name, status, body] of [
  ["unavailable", 503, `{"error":{"code":"SERVICE_UNAVAILABLE"}}`],
  ["not 200", 500, `{"decision":true}`],
  ["no decision", 200, `{}`],
  ["decision not a boolean", 200, `{"decision":"true"}`],
  ["not JSON", 200, `yes`]
] as const) {
  test(`fail closed on ${name}`, async () => {
    const logs = spyOn(console, "log").mockImplementation(() => {})
    onTestFinished(() => logs.mockRestore())
    const identity = serveIdentity(status, body)

    const got = await evaluate(identity.url, "req-1")
    expect(Result.isFailure(got)).toBe(true)
    const line = JSON.parse(String(logs.mock.calls[0]?.[0]))
    expect(line).toMatchObject({ message: "access evaluation failed", request_id: "req-1" })
  })
}

test("fail closed when identity is unreachable or unset", async () => {
  const logs = spyOn(console, "log").mockImplementation(() => {})
  onTestFinished(() => logs.mockRestore())
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const url = `http://127.0.0.1:${closed.port}`
  await closed.stop(true)

  expect(Result.isFailure(await evaluate(url, ""))).toBe(true)
  const unset = await evaluate(undefined, "")
  expect(Result.isFailure(unset) && unset.failure.message).toBe("IDENTITY_INTERNAL_URL is unset")
})
