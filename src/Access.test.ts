import { expect, onTestFinished, spyOn, test } from "bun:test"
import { ConfigProvider, Effect, Either, Tracer } from "effect"
import { Access, type Question } from "./Access.js"

const member = "01jd8x3k7q00000000000000mm"
const project = "01jd8x3k7q00000000000000pp"
const question: Question = {
  memberId: member,
  kind: "project",
  nodeId: project,
  permission: "project:read"
}

/** Identity, answering every evaluation with `status` and `body`, keeping what it got. */
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

/**
 * Asks identity at `identityUrl` (unset when undefined), as the API would, under `parent`
 * when there is one.
 */
const evaluate = (identityUrl: string | undefined, requestId: string, parent?: Tracer.AnySpan) => {
  const config = new Map([["TASK_ASSIGNEE_PERMISSION", "project:read"]])
  if (identityUrl !== undefined) config.set("IDENTITY_INTERNAL_URL", identityUrl)
  const ask = Effect.flatMap(Access, (access) => access.evaluate(question, requestId))
  return Effect.runPromise(
    (parent ? Effect.withParentSpan(ask, parent) : ask).pipe(
      Effect.either,
      Effect.provide(Access.Default),
      Effect.withConfigProvider(ConfigProvider.fromMap(config))
    )
  )
}

for (const decision of [true, false]) {
  test(`evaluate asks identity and answers ${decision}`, async () => {
    const identity = serveIdentity(200, JSON.stringify({ decision }))
    const parent = Tracer.externalSpan({
      traceId: "01000000000000000000000000000000",
      spanId: "0200000000000000"
    })

    expect(await evaluate(identity.url, "req-1", parent)).toEqual(Either.right(decision))
    expect(identity.got.body).toEqual({
      subject: { type: "member", id: member },
      resource: { type: "project", id: project },
      action: { name: "project:read" }
    })
    expect(identity.got.headers?.get("x-request-id")).toBe("req-1")
    // The trace goes on, from the call's own span.
    expect(identity.got.headers?.get("traceparent")).toMatch(
      /^00-01000000000000000000000000000000-[0-9a-f]{16}-01$/
    )
  })
}

for (const [name, status, body] of [
  ["not 200", 500, `{"decision":true}`],
  ["no decision", 200, `{}`],
  ["decision not a boolean", 200, `{"decision":"true"}`],
  ["not JSON", 200, `yes`]
] as const) {
  test(`no answer is an error: ${name}`, async () => {
    const logs = spyOn(console, "log").mockImplementation(() => {})
    onTestFinished(() => logs.mockRestore())
    const identity = serveIdentity(status, body)

    const got = await evaluate(identity.url, "req-1")
    expect(Either.isLeft(got)).toBe(true)
    // Logged with the request id.
    const line = JSON.parse(String(logs.mock.calls[0]?.[0]))
    expect(line.message).toBe("access evaluation failed")
    expect(line.request_id).toBe("req-1")
  })
}

test("no answer is an error: identity unreachable or unset", async () => {
  const logs = spyOn(console, "log").mockImplementation(() => {})
  onTestFinished(() => logs.mockRestore())
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const url = `http://127.0.0.1:${closed.port}`
  await closed.stop(true)

  expect(Either.isLeft(await evaluate(url, ""))).toBe(true)
  const unset = await evaluate(undefined, "")
  expect(Either.isLeft(unset) && unset.left.message).toBe("IDENTITY_INTERNAL_URL is unset")
})
