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
    method: "GET" | "POST" | "PATCH" | "DELETE",
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

  return { identity, send, create, get, list, logged }
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
