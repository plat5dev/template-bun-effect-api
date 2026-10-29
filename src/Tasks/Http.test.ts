import { HttpServer, OpenApi } from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { expect, onTestFinished, setSystemTime, spyOn, test } from "bun:test"
import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect"
import { Api } from "../Api.js"
import { PublicApiLive } from "../Http.js"
import { CREATED_HEADER, DETAILS_HEADER } from "../plat5/Audit.js"
import { TelemetryLive } from "../Telemetry.js"
import { MEMBER_HEADER, PROJECT_HEADER } from "./Api.js"

const environment = "01jd8x3k7q0000000000000000"
const other = "01jd8x3k7q0000000000000001"
const project = "01jd8x3k7q00000000000000pp"
const member = "01jd8x3k7q00000000000000mm"
const assignee = "01jd8x3k7q00000000000000aa"
const user = "01jd8x3k7q00000000000000u1"
// Not the starter's, to show the check asks for the configured one.
const permission = "tasks:assignable"

const tasksPath = `/environments/${environment}/tasks`
/** A write that sets the assignee. */
const assigning = JSON.stringify({ title: "Other", assignee_id: assignee })

/** What identity should be asked for an assignee on the project. */
const evaluation = (assigneeId: string) => ({
  subject: { type: "member", id: assigneeId },
  resource: { type: "project", id: project },
  action: { name: permission }
})

type Task = {
  id: string
  environment_id: string
  title: string
  status: string
  assignee_id: string | null
  created_by: string
}

type ErrorBody = {
  error: {
    code: string
    message: string
    request_id: string | null
    details: { fields?: { path: string; message: string }[] }
  }
}

/**
 * Identity, answering every access evaluation with `status` and `body` (a decision of true
 * until told otherwise), and keeping each body and its headers. It takes traces too, for an
 * app that exports them.
 */
const serveIdentity = () => {
  const identity = {
    url: "",
    status: 200,
    body: `{"decision":true}`,
    asked: [] as unknown[],
    headers: [] as Headers[]
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === "POST" && path === "/v1/traces") return new Response("{}")
      if (req.method !== "POST" || path !== "/access/v1/evaluation") {
        return new Response(null, { status: 404 })
      }
      identity.asked.push(await req.json())
      identity.headers.push(req.headers)
      return new Response(identity.body, {
        status: identity.status,
        headers: { "content-type": "application/json" }
      })
    }
  })
  identity.url = `http://127.0.0.1:${server.port}`
  return { identity, stop: () => server.stop(true) }
}

/** The public API, as main serves it, on a port of its own. */
const AppLive = PublicApiLive.pipe(
  Layer.provideMerge(BunHttpServer.layer({ port: 0, hostname: "127.0.0.1" })),
  Layer.provide(TelemetryLive)
)

/**
 * The API, with identity allowing every assignee until told otherwise. `identityUnset`
 * leaves IDENTITY_INTERNAL_URL unset; `tracesExported` sends traces to identity's fake.
 */
const newApp = async (opts: { identityUnset?: boolean; tracesExported?: boolean } = {}) => {
  // Request logs, to read and to keep out of the test output.
  const logs = spyOn(console, "log").mockImplementation(() => {})
  const { identity, stop } = serveIdentity()
  const scope = Effect.runSync(Scope.make())
  onTestFinished(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await stop()
    logs.mockRestore()
  })
  const config = new Map([["DATABASE_PATH", ":memory:"], ["TASK_ASSIGNEE_PERMISSION", permission]])
  if (!opts.identityUnset) config.set("IDENTITY_INTERNAL_URL", identity.url)
  if (opts.tracesExported) config.set("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", `${identity.url}/v1/traces`)
  const context = await Effect.runPromise(
    Layer.buildWithScope(AppLive, scope).pipe(
      Effect.withConfigProvider(ConfigProvider.fromMap(config))
    )
  )
  const { address } = Context.get(context, HttpServer.HttpServer)
  const base = `http://127.0.0.1:${address._tag === "TcpAddress" ? address.port : 0}`

  /**
   * Sends what the gateway sends on an environment route: the caller's member id and the
   * environment's project id, but for the header in `without`.
   */
  const send = (
    method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT" | "OPTIONS" | "HEAD",
    path: string,
    body?: string,
    opts: { without?: string; headers?: Record<string, string> } = {}
  ) => {
    const headers: Record<string, string> = {
      [MEMBER_HEADER]: member,
      [PROJECT_HEADER]: project,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...opts.headers
    }
    if (opts.without) delete headers[opts.without]
    return fetch(`${base}${path}`, { method, headers, body })
  }

  const create = async (environmentId: string, title: string): Promise<Task> => {
    const res = await send("POST", `/environments/${environmentId}/tasks`, JSON.stringify({ title }))
    expect(res.status).toBe(201)
    return (await res.json()) as Task
  }

  const get = async (taskId: string): Promise<Task> => {
    const res = await send("GET", `${tasksPath}/${taskId}`)
    expect(res.status).toBe(200)
    return (await res.json()) as Task
  }

  const list = async (query = ""): Promise<{ tasks: Task[]; has_more: boolean }> => {
    const res = await send("GET", `${tasksPath}${query}`)
    expect(res.status).toBe(200)
    return (await res.json()) as { tasks: Task[]; has_more: boolean }
  }

  const logged = (): Record<string, unknown>[] =>
    logs.mock.calls.flatMap((call) => {
      try {
        return [JSON.parse(String(call[0]))]
      } catch {
        return []
      }
    })

  return { identity, send, create, get, list, logged, base }
}

const errorOf = async (res: Response) => ((await res.json()) as ErrorBody).error

test("create", async () => {
  const { create } = await newApp()
  const task = await create(environment, "Launch")
  expect(task.environment_id).toBe(environment)
  expect(task.created_by).toBe(member)
  expect(task.status).toBe("todo")
  expect(task.assignee_id).toBeNull()
  expect(task.id).toMatch(/^[0-9a-z]{26}$/)
})

test("create needs the member, before the body", async () => {
  const { send } = await newApp()
  for (const body of [`{"title":"Launch"}`, `{"title":""}`, `{`]) {
    const res = await send("POST", tasksPath, body, { without: MEMBER_HEADER })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe("INVALID_REQUEST")
  }
})

test("scoped by environment", async () => {
  const { send, create, list } = await newApp()
  const task = await create(other, "Elsewhere")
  for (const method of ["GET", "PATCH", "DELETE"] as const) {
    const body = method === "PATCH" ? `{"title":"x"}` : undefined
    const res = await send(method, `${tasksPath}/${task.id}`, body)
    expect(res.status).toBe(404)
  }
  expect((await list()).tasks).toEqual([])
})

test("list pages", async () => {
  const { create, list } = await newApp()
  const ids: string[] = []
  for (const title of ["a", "b", "c"]) ids.push((await create(environment, title)).id)

  const first = await list("?limit=2")
  expect(first.tasks.map((task) => task.id)).toEqual(ids.slice(0, 2))
  expect(first.has_more).toBe(true)
  const second = await list(`?limit=2&starting_after=${first.tasks[1]!.id}`)
  expect(second.tasks.map((task) => task.id)).toEqual(ids.slice(2))
  expect(second.has_more).toBe(false)
})

test("tasks made in the same millisecond list in the order they were made", async () => {
  const { create, list } = await newApp()
  setSystemTime(new Date("2026-10-28T00:00:00.000Z"))
  const ids: string[] = []
  try {
    for (let i = 0; i < 10; i++) ids.push((await create(environment, `t${i}`)).id)
  } finally {
    setSystemTime()
  }
  expect((await list()).tasks.map((task) => task.id)).toEqual(ids)
})

test("audit details", async () => {
  const { send } = await newApp()
  const details = (res: Response) => {
    const header = res.headers.get(DETAILS_HEADER)
    return header === null ? undefined : JSON.parse(header)
  }

  let res = await send("POST", tasksPath, `{"title":"Launch"}`)
  const task = (await res.json()) as Task
  expect(res.headers.get(CREATED_HEADER)).toBe(task.id)
  expect(details(res)).toEqual({ task_id: task.id, title: "Launch", status: "todo", assignee_id: null })

  const path = `${tasksPath}/${task.id}`
  res = await send("PATCH", path, `{"status":"done"}`)
  expect(details(res)).toEqual({ status: { from: "todo", to: "done" } })

  res = await send("PATCH", path, JSON.stringify({ assignee_id: assignee }))
  expect(details(res)).toEqual({ assignee_id: { from: null, to: assignee } })

  res = await send("PATCH", path, `{"assignee_id":null}`)
  expect(details(res)).toEqual({ assignee_id: { from: assignee, to: null } })

  res = await send("PATCH", path, `{"status":"done"}`)
  expect(details(res)).toBeUndefined()

  res = await send("DELETE", path)
  expect(res.status).toBe(204)
  expect(details(res)).toBeUndefined()
})

test("create with an assignee", async () => {
  const { identity, send, get } = await newApp()
  const res = await send("POST", tasksPath, JSON.stringify({ title: "Launch", assignee_id: assignee }))
  expect(res.status).toBe(201)
  const task = (await res.json()) as Task
  expect(task.assignee_id).toBe(assignee)
  expect((await get(task.id)).assignee_id).toBe(assignee)
  // The assignee, on the project from the header, for the configured permission.
  expect(identity.asked).toEqual([evaluation(assignee)])
})

for (const tracesExported of [false, true]) {
  test(`the evaluation carries the request's X-Request-ID and trace (traces exported: ${tracesExported})`, async () => {
    const { identity, send } = await newApp({ tracesExported })
    const traceId = "0af7651916cd43dd8448eb211c80319c"
    const body = JSON.stringify({ title: "Launch", assignee_id: assignee })
    const res = await send("POST", tasksPath, body, {
      headers: { "x-request-id": "req-1", traceparent: `00-${traceId}-b7ad6b7169203331-01` }
    })
    expect(res.status).toBe(201)
    expect(identity.headers[0]?.get("x-request-id")).toBe("req-1")
    expect(identity.headers[0]?.get("traceparent")).toMatch(new RegExp(`^00-${traceId}-`))
  })
}

test("a refused assignee is a 422, and nothing is written", async () => {
  const { identity, send, create, list } = await newApp()
  const task = await create(environment, "Launch")
  identity.body = `{"decision":false}`

  const want = "That person can't see this project."
  for (const [method, path] of [["POST", tasksPath], ["PATCH", `${tasksPath}/${task.id}`]] as const) {
    const res = await send(method, path, assigning)
    expect(res.status).toBe(422)
    const error = await errorOf(res)
    expect(error.code).toBe("VALIDATION_ERROR")
    expect(error.message).toBe(want)
    expect(error.details.fields).toEqual([{ path: "assignee_id", message: want }])
  }
  // Nothing written: no second task, and the first unchanged.
  const { tasks } = await list()
  expect(tasks.map((t) => [t.title, t.assignee_id])).toEqual([["Launch", null]])
  expect(identity.asked).toEqual([evaluation(assignee), evaluation(assignee)])
})

for (const [name, status, answer, identityUnset] of [
  ["identity answers 500", 500, `{"error":{}}`, false],
  ["identity answers without a decision", 200, `{}`, false],
  ["IDENTITY_INTERNAL_URL unset", 200, `{"decision":true}`, true]
] as const) {
  test(`no answer is a 503, and nothing is written: ${name}`, async () => {
    const { identity, send, create, list, logged } = await newApp({ identityUnset })
    const task = await create(environment, "Launch")
    identity.status = status
    identity.body = answer

    for (const [method, path] of [["POST", tasksPath], ["PATCH", `${tasksPath}/${task.id}`]] as const) {
      const res = await send(method, path, assigning, { headers: { "x-request-id": `req-${method}` } })
      expect(res.status).toBe(503)
      const error = await errorOf(res)
      expect(error.code).toBe("SERVICE_UNAVAILABLE")
      expect(error.request_id).toBe(`req-${method}`)
    }
    const { tasks } = await list()
    expect(tasks.map((t) => [t.title, t.assignee_id])).toEqual([["Launch", null]])
    // Logged with the request id.
    const failures = logged().filter((line) => line.message === "access evaluation failed")
    expect(failures.map((line) => line.request_id)).toEqual(["req-POST", "req-PATCH"])
  })
}

test("update an assignee", async () => {
  const { identity, send, create, get } = await newApp()
  const task = await create(environment, "Launch")
  const path = `${tasksPath}/${task.id}`

  let res = await send("PATCH", path, JSON.stringify({ assignee_id: assignee }))
  expect(res.status).toBe(200)
  expect(((await res.json()) as Task).assignee_id).toBe(assignee)
  expect(identity.asked).toEqual([evaluation(assignee)])

  // The same member again is still checked.
  res = await send("PATCH", path, JSON.stringify({ assignee_id: assignee }))
  expect(res.status).toBe(200)
  expect(identity.asked.length).toBe(2)

  // Absent leaves the assignee, and null unassigns: neither asks identity.
  res = await send("PATCH", path, `{"title":"Renamed"}`)
  expect(res.status).toBe(200)
  expect(((await res.json()) as Task).assignee_id).toBe(assignee)
  res = await send("PATCH", path, `{"assignee_id":null}`)
  expect(res.status).toBe(200)
  expect(((await res.json()) as Task).assignee_id).toBeNull()
  expect((await get(task.id)).assignee_id).toBeNull()
  expect(identity.asked.length).toBe(2)
})

test("no assignee, no check", async () => {
  const { identity, send, list } = await newApp()
  // Without an assignee, the project header isn't needed either.
  for (const body of [`{"title":"a"}`, `{"title":"b","assignee_id":null}`]) {
    const res = await send("POST", tasksPath, body, { without: PROJECT_HEADER })
    expect(res.status).toBe(201)
    expect(((await res.json()) as Task).assignee_id).toBeNull()
  }
  const task = (await list()).tasks[0]!
  for (const body of [`{"status":"done"}`, `{"assignee_id":null}`]) {
    const res = await send("PATCH", `${tasksPath}/${task.id}`, body, { without: PROJECT_HEADER })
    expect(res.status).toBe(200)
  }
  expect(identity.asked).toEqual([])
})

test("an assignee needs the project", async () => {
  const { identity, send, create, list } = await newApp()
  const task = await create(environment, "Launch")
  for (const [method, path] of [["POST", tasksPath], ["PATCH", `${tasksPath}/${task.id}`]] as const) {
    const res = await send(method, path, assigning, { without: PROJECT_HEADER })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe("INVALID_REQUEST")
  }
  const { tasks } = await list()
  expect(tasks.map((t) => t.title)).toEqual(["Launch"])
  expect(identity.asked).toEqual([])
})

test("a bad assignee id is a 422 at assignee_id", async () => {
  const { identity, send, create } = await newApp()
  const task = await create(environment, "Launch")
  for (const value of [`""`, `"someone"`, `"01JD8X3K7Q00000000000000AA"`, `5`, `{}`]) {
    for (const [method, path] of [["POST", tasksPath], ["PATCH", `${tasksPath}/${task.id}`]] as const) {
      const res = await send(method, path, `{"title":"Other","assignee_id":${value}}`)
      expect(res.status).toBe(422)
      const error = await errorOf(res)
      expect(error.code).toBe("VALIDATION_ERROR")
      expect(error.details.fields).toEqual([{ path: "assignee_id", message: "That doesn't look right." }])
    }
  }
  expect(identity.asked).toEqual([])
})

test("update order: the body, then the task, then identity", async () => {
  const { identity, send } = await newApp()
  const missing = `${tasksPath}/01jd8x3k7q00000000000000zz`
  const assign = JSON.stringify({ assignee_id: assignee })

  let res = await send("PATCH", missing, JSON.stringify({ title: "", assignee_id: assignee }))
  expect(res.status).toBe(422)
  res = await send("PATCH", missing, assign)
  expect(res.status).toBe(404)
  res = await send("PATCH", missing, assign, { without: PROJECT_HEADER })
  expect(res.status).toBe(404)
  expect(identity.asked).toEqual([])
})

test("request logs carry the ids the front door gave", async () => {
  const { send, logged } = await newApp()
  await send("GET", tasksPath)
  await send("GET", `/users/${user}/profile`)
  const lines = logged().filter((line) => line.message === "request completed")
  expect(lines.map((line) => [line.node_id, line.member_id, line.user_id])).toEqual([
    [environment, member, undefined],
    [undefined, member, user]
  ])
})

test("the OpenAPI document has the assignee and the answers", () => {
  const spec = OpenApi.fromApi(Api)
  const task = spec.components.schemas["Task.json"] as { required: string[] }
  expect(task.required).toContain("assignee_id")
  const tasks = spec.paths["/environments/{environment_id}/tasks"]!
  const one = spec.paths["/environments/{environment_id}/tasks/{task_id}"]!
  for (const op of [tasks.post!, one.patch!]) {
    const body = op.requestBody?.content["application/json"]?.schema as {
      properties: Record<string, { anyOf: { type: string }[] }>
    }
    expect(body.properties.assignee_id?.anyOf.map((s) => s.type)).toEqual(["string", "null"])
  }
  expect(Object.keys(tasks.post!.responses)).toEqual(["201", "400", "422", "500", "503"])
  expect(Object.keys(one.patch!.responses)).toEqual(["200", "400", "404", "422", "500", "503"])
})

// Parity with the Go starter: each test below pins one behavior the starters share.

const FALLBACK = "That doesn't look right."

/** The 422 for one field. */
const expectField = async (res: Response, path: string, message: string) => {
  expect(res.status).toBe(422)
  const error = await errorOf(res)
  expect(error.code).toBe("VALIDATION_ERROR")
  expect(error.message).toBe(message)
  expect(error.details.fields).toEqual([{ path, message }])
}

/** The headers to send `contentType`, or to send none. */
const sending = (contentType: string | undefined) =>
  contentType === undefined ? { without: "content-type" } : { headers: { "content-type": contentType } }

test("title and status errors, word for word", async () => {
  const { send, create } = await newApp()
  const task = await create(environment, "Launch")
  for (const [method, path] of [["POST", tasksPath], ["PATCH", `${tasksPath}/${task.id}`]] as const) {
    for (const title of ["", "   ", "\u3000\u0085"]) {
      await expectField(await send(method, path, JSON.stringify({ title })), "title", "Title is required.")
    }
    await expectField(await send(method, path, JSON.stringify({ title: "x".repeat(256) })), "title", "Title is too long.")
    for (const status of ["TODO", "in progress", " done", ""]) {
      const res = await send(method, path, JSON.stringify({ title: "Launch", status }))
      await expectField(res, "status", "Status must be todo, in progress, or done.")
    }
  }
  // A create without a title.
  for (const body of [`{}`, `{"title":null}`, `null`]) {
    await expectField(await send("POST", tasksPath, body), "title", "Title is required.")
  }
})

test("titles are trimmed of Unicode white space, as Go's strings.TrimSpace", async () => {
  const { send, create } = await newApp()
  let res = await send("POST", tasksPath, JSON.stringify({ title: " \t\u00a0Launch\u0085\u3000 " }))
  expect(res.status).toBe(201)
  expect(((await res.json()) as Task).title).toBe("Launch")
  // U+FEFF isn't white space to Go. (Not at the start: bun:sqlite drops a leading one.)
  res = await send("POST", tasksPath, JSON.stringify({ title: "Launch\ufeff" }))
  expect(((await res.json()) as Task).title).toBe("Launch\ufeff")
  const task = await create(environment, "Launch")
  res = await send("PATCH", `${tasksPath}/${task.id}`, JSON.stringify({ title: "  Renamed  " }))
  expect(res.status).toBe(200)
  expect(((await res.json()) as Task).title).toBe("Renamed")
})

test("a title's limit counts characters, not UTF-16 units", async () => {
  const { send, get } = await newApp()
  for (const [title, ok] of [
    ["é".repeat(255), true],
    ["😀".repeat(255), true],
    ["é".repeat(256), false],
    ["😀".repeat(256), false]
  ] as const) {
    const res = await send("POST", tasksPath, JSON.stringify({ title }))
    if (!ok) {
      await expectField(res, "title", "Title is too long.")
      continue
    }
    expect(res.status).toBe(201)
    // And it reads back.
    expect((await get(((await res.json()) as Task).id)).title).toBe(title)
  }
})

test("PATCH: null leaves a field as it is, and a no-op still answers the task", async () => {
  const { send, create } = await newApp()
  const task = await create(environment, "Launch")
  for (const body of [`{"title":null,"status":null}`, `{}`, `null`]) {
    const res = await send("PATCH", `${tasksPath}/${task.id}`, body)
    expect(res.status).toBe(200)
    const updated = (await res.json()) as Task
    expect([updated.title, updated.status]).toEqual(["Launch", "todo"])
    expect(res.headers.get(DETAILS_HEADER)).toBeNull()
  }
})

test("DELETE never reads its body", async () => {
  const { send, create } = await newApp()
  for (const [contentType, body] of [
    ["application/json", ""],
    ["application/json", "{"],
    ["text/plain", "hello"],
    ["not a type", "{}"],
    [undefined, "x"]
  ] as const) {
    const task = await create(environment, "Launch")
    const res = await send("DELETE", `${tasksPath}/${task.id}`, body, sending(contentType))
    expect(res.status).toBe(204)
  }
})

test("a known path in another method, or OPTIONS, is the unknown route's 404", async () => {
  const { send, create } = await newApp()
  const task = await create(environment, "Launch")
  const taskPath = `${tasksPath}/${task.id}`
  for (const [method, path] of [
    ["PUT", taskPath],
    ["POST", taskPath],
    ["DELETE", tasksPath],
    ["PATCH", tasksPath],
    ["PATCH", `/users/${user}/profile`],
    ["OPTIONS", tasksPath],
    ["OPTIONS", taskPath],
    ["GET", "/nope"],
    ["GET", `/users/${user}`]
  ] as const) {
    const body = method === "OPTIONS" || method === "GET" ? undefined : "{}"
    const res = await send(method, path, body, { headers: { "x-request-id": "req-9" } })
    expect(res.status).toBe(404)
    expect(res.headers.get("allow")).toBeNull()
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(await res.json()).toEqual({
      error: {
        type: "invalid_request_error",
        code: "NOT_FOUND",
        message: "Resource not found.",
        request_id: "req-9",
        details: { resource: "resource", id: null }
      }
    })
  }
  // HEAD on a GET route is the GET's answer, without a body; a trailing slash is the same route.
  let res = await send("HEAD", tasksPath)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe("")
  res = await send("GET", `${tasksPath}/`)
  expect(res.status).toBe(200)
})

test("a body not sent as JSON is a 422 at body, and nothing is written", async () => {
  const { send, create, list } = await newApp()
  const task = await create(environment, "Launch")
  for (const [contentType, body] of [
    [undefined, `{"title":"Other"}`],
    [undefined, ""],
    ["text/plain", `{"title":"Other"}`],
    ["text/plain", ""],
    ["application/x-www-form-urlencoded", "title=Other"],
    ["application/jsonx", `{"title":"Other"}`],
    ["", `{"title":"Other"}`],
    ["not a type", `{"title":"Other"}`]
  ] as const) {
    for (const [method, path] of [["POST", tasksPath], ["PATCH", `${tasksPath}/${task.id}`]] as const) {
      await expectField(await send(method, path, body, sending(contentType)), "body", FALLBACK)
    }
  }
  expect((await list()).tasks.map((t) => t.title)).toEqual(["Launch"])
})

test("JSON is application/json with any parameters, or application/…+json", async () => {
  const { send } = await newApp()
  for (const contentType of [
    "application/json; charset=utf-8",
    "Application/JSON",
    "application/json;charset=UTF-8;",
    'application/json; charset="utf-8"',
    "application/merge-patch+json",
    "application/vnd.api+json"
  ]) {
    const res = await send("POST", tasksPath, `{"title":"Launch"}`, sending(contentType))
    expect(res.status).toBe(201)
  }
})

test("a body that isn't a JSON object is a 422 at body", async () => {
  const { send, create } = await newApp()
  const task = await create(environment, "Launch")
  for (const body of ["", " ", "{", `{"title":"a"} x`, `[{"title":"a"}]`, `"a"`, "5", "true"]) {
    for (const [method, path] of [["POST", tasksPath], ["PATCH", `${tasksPath}/${task.id}`]] as const) {
      await expectField(await send(method, path, body), "body", FALLBACK)
    }
  }
})

test("a field of the wrong JSON type is a 422 at body, never coerced", async () => {
  const { send, create } = await newApp()
  const task = await create(environment, "Launch")
  for (const body of [
    `{"title":123}`,
    `{"title":true}`,
    `{"title":["a"]}`,
    `{"title":"Launch","status":5}`,
    // Every field's type before any field's value.
    `{"title":"","status":5}`
  ]) {
    for (const [method, path] of [["POST", tasksPath], ["PATCH", `${tasksPath}/${task.id}`]] as const) {
      await expectField(await send(method, path, body), "body", FALLBACK)
    }
  }
})

test("keys match their fields ignoring case, as Go's decoder", async () => {
  const { send } = await newApp()
  const res = await send("POST", tasksPath, `{"TITLE":"Launch","Status":"done","other":1}`)
  expect(res.status).toBe(201)
  const task = (await res.json()) as Task
  expect([task.title, task.status]).toEqual(["Launch", "done"])
})

test("a body over 1 MiB is a 413 before anything else, on any route", async () => {
  const { send } = await newApp()
  const big = `{"title":"${"x".repeat(1 << 20)}"}`
  for (const [method, path, without] of [
    ["POST", tasksPath, MEMBER_HEADER],
    ["POST", tasksPath, undefined],
    ["PATCH", `${tasksPath}/01jd8x3k7q00000000000000zz`, undefined],
    ["PUT", `/users/${user}/profile`, undefined],
    ["POST", "/nope", undefined]
  ] as const) {
    const res = await send(method, path, big, without ? { without } : {})
    expect(res.status).toBe(413)
    expect(res.headers.get("allow")).toBeNull()
    expect(await res.json()).toEqual({
      error: {
        type: "invalid_request_error",
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body is too large.",
        request_id: null,
        details: { max_size_bytes: 1048576 }
      }
    })
  }
  // Exactly 1 MiB is read.
  const fits = `{"title":"a","pad":"${"x".repeat((1 << 20) - 22)}"}`
  expect(Buffer.byteLength(fits)).toBe(1 << 20)
  expect((await send("POST", tasksPath, fits)).status).toBe(201)
})

test("list parameters, as Go reads them", async () => {
  const { send, create } = await newApp()
  for (const title of ["a", "b"]) await create(environment, title)
  const count = async (query: string) => {
    const res = await send("GET", `${tasksPath}${query}`)
    expect(res.status).toBe(200)
    return ((await res.json()) as { tasks: Task[] }).tasks.length
  }
  expect(await count("?limit=%2B1")).toBe(1) // a sign, as strconv.Atoi takes it
  expect(await count("?limit=001")).toBe(1)
  expect(await count("?limit=%201%20")).toBe(1) // trimmed
  expect(await count("?limit=1000")).toBe(2) // clamped
  expect(await count("?limit=")).toBe(2) // empty is the default
  expect(await count("?limit=1&limit=abc")).toBe(1) // the first value
  for (const limit of ["abc", "1.5", "0", "-1", "-0", "1e2", "99999999999999999999", "%2B"]) {
    await expectField(await send("GET", `${tasksPath}?limit=${limit}`), "limit", FALLBACK)
  }
  for (const after of ["nope", "01JD8X3K7Q0000000000000000", "81jd8x3k7q0000000000000000", "01jd8x3k7q000000000000000i"]) {
    await expectField(await send("GET", `${tasksPath}?starting_after=${after}`), "starting_after", FALLBACK)
  }
  // The limit first.
  await expectField(await send("GET", `${tasksPath}?limit=x&starting_after=x`), "limit", FALLBACK)
})

test("request_id is X-Request-ID as sent, or null", async () => {
  const { send } = await newApp()
  for (const [sent, want] of [[undefined, null], ["", null], ["req-1", "req-1"]] as const) {
    const res = await send(
      "GET",
      `${tasksPath}/01jd8x3k7q00000000000000zz`,
      undefined,
      sent === undefined ? {} : { headers: { "x-request-id": sent } }
    )
    expect((await errorOf(res)).request_id).toBe(want)
  }
})

test("audit details: sorted keys, HTML and non-ASCII escaped", async () => {
  const { send } = await newApp()
  const res = await send("POST", tasksPath, JSON.stringify({ title: "<é😀&>" }))
  const task = (await res.json()) as Task
  expect(res.headers.get(DETAILS_HEADER)).toBe(
    `{"assignee_id":null,"status":"todo","task_id":"${task.id}","title":"\\u003c\\u00e9\\ud83d\\ude00\\u0026\\u003e"}`
  )
})

test("times are RFC 3339 UTC without trailing zeros, as Go's RFC3339Nano", async () => {
  const { create } = await newApp()
  setSystemTime(new Date("2026-10-28T00:00:00.100Z"))
  try {
    const task = (await create(environment, "Launch")) as Task & { created_at: string; updated_at: string }
    expect(task.created_at).toBe("2026-10-28T00:00:00.1Z")
    expect(task.updated_at).toBe(task.created_at)
  } finally {
    setSystemTime()
  }
})

test("the request log: the route's template or unknown, warn on a 4xx", async () => {
  const { send, logged } = await newApp()
  await send("GET", tasksPath)
  await send("GET", `${tasksPath}/01jd8x3k7q00000000000000zz`, undefined, { headers: { "x-request-id": "req-2" } })
  await send("GET", "/nope/01jd8x3k7q00000000000000zz")
  await send("PATCH", `/users/${user}/profile`, "{}")
  const [ok, missing, unknown, wrongMethod] = logged().filter((line) => line.message === "request completed")
  expect(ok!.route).toBe("/environments/:environment_id/tasks")
  expect(ok!.level).toBe("info")
  expect("request_id" in ok!).toBe(false)
  expect([ok!.node_id, ok!.member_id]).toEqual([environment, member])
  expect(missing!.route).toBe("/environments/:environment_id/tasks/:task_id")
  expect(missing!.level).toBe("warn")
  expect(missing!.request_id).toBe("req-2")
  expect([unknown!.route, unknown!.level]).toEqual(["unknown", "warn"])
  // No route, so no user id.
  expect([wrongMethod!.route, wrongMethod!.user_id]).toEqual(["unknown", undefined])
})
