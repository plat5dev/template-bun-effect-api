import { expect, onTestFinished, setSystemTime, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { OpenApi } from "effect/http-api"
import { SqlClient } from "effect/sql"
import { Access } from "./Access.js"
import { AppConfig } from "./Config.js"
import { Api } from "./Http.js"
import { CREATED_HEADER, DETAILS_HEADER } from "./plat5/Audit.js"
import { SqlLive } from "./Sql.js"
import { ASSIGNEE_PERMISSION, MEMBER_HEADER, Task, TaskId, Tasks, TasksRepo } from "./Tasks.js"
import { envLayer, makeTestApp } from "./testing.js"

const project = "01jd8x3k7q0000000000000000"
const other = "01jd8x3k7q0000000000000001"
const member = "01jd8x3k7q00000000000000mm"
const assignee = "01jd8x3k7q00000000000000aa"
const user = "01jd8x3k7q00000000000000u1"
const permission = ASSIGNEE_PERMISSION

const tasksPath = `/projects/${project}/tasks`
const assigning = JSON.stringify({ title: "Other", assignee_id: assignee })

const evaluation = (assigneeId: string) => ({
  subject: { type: "member", id: assigneeId },
  resource: { type: "project", id: project },
  action: { name: permission }
})

type TaskDto = {
  id: string
  project_id: string
  title: string
  status: string
  assignee_id: string | null
  created_by: string
  created_at: string
  updated_at: string
}

type ErrorBody = {
  error: {
    code: string
    message: string
    request_id: string | null
    details: { fields?: { path: string; message: string }[] } | null
  }
}

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
  onTestFinished(() => server.stop(true))
  identity.url = `http://127.0.0.1:${server.port}`
  return identity
}

const newApp = (opts: { identityUnset?: boolean; tracesExported?: boolean } = {}) => {
  const identity = serveIdentity()
  const env: Record<string, string> = {}
  if (!opts.identityUnset) env.IDENTITY_INTERNAL_URL = identity.url
  if (opts.tracesExported) env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${identity.url}/v1/traces`
  const app = makeTestApp(env)

  const send = (
    method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT" | "OPTIONS" | "HEAD",
    path: string,
    body?: string,
    reqOpts: { without?: string; headers?: Record<string, string> } = {}
  ) => {
    const projectId = /^\/projects\/([^/?]+)/.exec(path)?.[1]
    const userId = /^\/users\/([^/?]+)/.exec(path)?.[1]
    const headers: Record<string, string> = {
      ...(projectId ? { "x-plat5-project-id": projectId, [MEMBER_HEADER]: member } : {}),
      ...(userId ? { "x-plat5-user-id": userId } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...reqOpts.headers
    }
    if (reqOpts.without) delete headers[reqOpts.without]
    return app.fetch(path, { method, headers, body })
  }

  const create = async (projectId: string, title: string): Promise<TaskDto> => {
    const res = await send("POST", `/projects/${projectId}/tasks`, JSON.stringify({ title }))
    expect(res.status).toBe(201)
    return (await res.json()) as TaskDto
  }

  const get = async (taskId: string): Promise<TaskDto> => {
    const res = await send("GET", `${tasksPath}/${taskId}`)
    expect(res.status).toBe(200)
    return (await res.json()) as TaskDto
  }

  const list = async (query = ""): Promise<{ tasks: TaskDto[]; has_more: boolean }> => {
    const res = await send("GET", `${tasksPath}${query}`)
    expect(res.status).toBe(200)
    return (await res.json()) as { tasks: TaskDto[]; has_more: boolean }
  }

  return { identity, send, create, get, list, logged: app.logged }
}

const errorOf = async (res: Response) => ((await res.json()) as ErrorBody).error

test("create task and require x-plat5-member-id", async () => {
  const { create, send } = newApp()
  const task = await create(project, "  Launch  ")
  expect(task.project_id).toBe(project)
  expect(task.created_by).toBe(member)
  expect(task.title).toBe("Launch")
  expect(task.status).toBe("todo")
  expect(task.assignee_id).toBeNull()
  expect(task.id).toMatch(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/)

  for (const body of [`{"title":"Launch"}`, `{"title":""}`, `{`]) {
    const res = await send("POST", tasksPath, body, { without: MEMBER_HEADER })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe("INVALID_REQUEST")
  }
})

test("tenant isolation: tasks are scoped by project_id", async () => {
  const { send, create, list } = newApp()
  const task = await create(other, "Elsewhere")
  for (const method of ["GET", "PATCH", "DELETE"] as const) {
    const res = await send(method, `${tasksPath}/${task.id}`, method === "PATCH" ? `{"title":"x"}` : undefined)
    expect(res.status).toBe(404)
  }
  expect((await list()).tasks).toEqual([])
})

test("pagination: limit, clamping, starting_after, validation, and monotonic ordering", async () => {
  const { create, list, send } = newApp()
  setSystemTime(new Date("2026-10-28T00:00:00.000Z"))
  const ids: string[] = []
  try {
    for (const title of ["a", "b", "c"]) ids.push((await create(project, title)).id)
  } finally {
    setSystemTime()
  }

  const first = await list("?limit=2")
  expect(first.tasks.map((t) => t.id)).toEqual(ids.slice(0, 2))
  expect(first.has_more).toBe(true)

  const second = await list(`?limit=1000&starting_after=${first.tasks[1]!.id}`)
  expect(second.tasks.map((t) => t.id)).toEqual(ids.slice(2))
  expect(second.has_more).toBe(false)

  for (const query of ["?limit=0", "?limit=-1", "?limit=abc", "?starting_after=bad", "?starting_after=01JD8X3K7Q0000000000000000"]) {
    const res = await send("GET", `${tasksPath}${query}`)
    expect(res.status, query).toBe(422)
    expect((await errorOf(res)).code).toBe("VALIDATION_ERROR")
  }
})

test("no-op PATCH does not write to DB or bump updated_at", async () => {
  const { send, create, get } = newApp()
  setSystemTime(new Date("2026-10-28T00:00:00.100Z"))
  let task: TaskDto
  try {
    task = await create(project, "Launch")
    setSystemTime(new Date("2026-10-28T00:05:00.000Z"))
    for (const body of [`{}`, `{"title":null,"status":null}`, `{"title":"Launch","status":"todo"}`]) {
      const res = await send("PATCH", `${tasksPath}/${task.id}`, body)
      expect(res.status).toBe(200)
      const patched = (await res.json()) as TaskDto
      expect(patched.updated_at).toBe("2026-10-28T00:00:00.100Z")
      expect(res.headers.get(DETAILS_HEADER)).toBeNull()
    }
    expect((await get(task.id)).updated_at).toBe("2026-10-28T00:00:00.100Z")
  } finally {
    setSystemTime()
  }
})

test("audit headers on POST, PATCH, and DELETE (visible ASCII without HTML escaping)", async () => {
  const { send } = newApp()
  const details = (res: Response) => {
    const header = res.headers.get(DETAILS_HEADER)
    return header === null ? undefined : JSON.parse(header)
  }

  let res = await send("POST", tasksPath, JSON.stringify({ title: "<é😀&>" }))
  const task = (await res.json()) as TaskDto
  expect(res.headers.get(CREATED_HEADER)).toBe(task.id)
  expect(res.headers.get(DETAILS_HEADER)).toBe(
    `{"assignee_id":null,"status":"todo","task_id":"${task.id}","title":"<\\u00e9\\ud83d\\ude00&>"}`
  )

  const path = `${tasksPath}/${task.id}`
  res = await send("PATCH", path, `{"status":"done"}`)
  expect(details(res)).toEqual({ status: { from: "todo", to: "done" } })

  res = await send("PATCH", path, JSON.stringify({ assignee_id: assignee }))
  expect(details(res)).toEqual({ assignee_id: { from: null, to: assignee } })

  res = await send("PATCH", path, `{"assignee_id":null}`)
  expect(details(res)).toEqual({ assignee_id: { from: assignee, to: null } })

  res = await send("DELETE", path)
  expect(res.status).toBe(204)
  expect(details(res)).toBeUndefined()

  // Deleting again returns 404.
  res = await send("DELETE", path)
  expect(res.status).toBe(404)
})

test("assignee access evaluation: allow, refuse 422, fail-closed 503, and header/trace propagation", async () => {
  const { identity, send, create, list } = newApp()
  const traceId = "0af7651916cd43dd8448eb211c80319c"

  // Allowed assignee carries X-Request-ID and traceparent.
  let res = await send("POST", tasksPath, JSON.stringify({ title: "Launch", assignee_id: assignee }), {
    headers: { "x-request-id": "req-1", traceparent: `00-${traceId}-b7ad6b7169203331-01` }
  })
  expect(res.status).toBe(201)
  expect(identity.asked).toEqual([evaluation(assignee)])
  expect(identity.headers[0]?.get("x-request-id")).toBe("req-1")
  expect(identity.headers[0]?.get("traceparent")).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`))

  // Refused assignee -> 422, nothing written.
  const task = await create(project, "Second")
  identity.body = `{"decision":false}`
  for (const [method, path] of [["POST", tasksPath], ["PATCH", `${tasksPath}/${task.id}`]] as const) {
    res = await send(method, path, assigning)
    expect(res.status).toBe(422)
    const err = await errorOf(res)
    expect(err.code).toBe("VALIDATION_ERROR")
    expect(err.details?.fields).toEqual([{ path: "assignee_id", message: "That person can't see this project." }])
  }

  // Unavailable identity -> 503 fail-closed.
  identity.status = 503
  identity.body = `{"error":{"code":"SERVICE_UNAVAILABLE"}}`
  res = await send("PATCH", `${tasksPath}/${task.id}`, assigning, { headers: { "x-request-id": "req-503" } })
  expect(res.status).toBe(503)
  expect(await errorOf(res)).toMatchObject({ code: "SERVICE_UNAVAILABLE", request_id: "req-503" })

  // IDENTITY_INTERNAL_URL unset -> 503 fail-closed.
  const unsetApp = newApp({ identityUnset: true })
  res = await unsetApp.send("POST", tasksPath, assigning)
  expect(res.status).toBe(503)
  expect((await errorOf(res)).code).toBe("SERVICE_UNAVAILABLE")

  // Verify refused/failed writes didn't add tasks or mutate Second.
  expect((await list()).tasks.length).toBe(2)
})

test("validation: bad content-type/JSON -> 400; invalid fields/unknown keys -> 422", async () => {
  const { send, create } = newApp()
  const task = await create(project, "Launch")

  for (const [contentType, body] of [
    [undefined, `{"title":"x"}`],
    ["text/plain", `{"title":"x"}`],
    ["application/json", ""],
    ["application/json", "{"]
  ] as const) {
    const res = await send("POST", tasksPath, body, contentType === undefined ? { without: "content-type" } : { headers: { "content-type": contentType } })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe("INVALID_REQUEST")
  }

  for (const body of [
    `{}`,
    `{"title":"   "}`,
    JSON.stringify({ title: "😀".repeat(256) }),
    `{"title":"ok","status":"nope"}`,
    `{"title":"ok","assignee_id":"not-a-ulid"}`,
    `{"title":"ok","extra":1}`,
    `[]`
  ]) {
    const res = await send("POST", tasksPath, body)
    expect(res.status, body).toBe(422)
    expect((await errorOf(res)).code).toBe("VALIDATION_ERROR")
  }

  // Update order: invalid body -> 422 before 404; valid body on missing task -> 404.
  const missing = `${tasksPath}/01jd8x3k7q00000000000000zz`
  expect((await send("PATCH", missing, `{"title":""}`)).status).toBe(422)
  expect((await send("PATCH", missing, `{"title":"Valid"}`)).status).toBe(404)
  // Valid task still unchanged.
  expect((await (await send("GET", `${tasksPath}/${task.id}`)).json() as TaskDto).title).toBe("Launch")
})

test("unknown routes and wrong methods return 404 envelope", async () => {
  const { send } = newApp()
  for (const [method, path] of [
    ["GET", "/nope"],
    ["PATCH", `/users/${user}/profile`],
    ["OPTIONS", tasksPath]
  ] as const) {
    const res = await send(method, path, method === "PATCH" ? "{}" : undefined, { headers: { "x-request-id": "req-404" } })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: {
        type: "invalid_request_error",
        code: "NOT_FOUND",
        message: "Resource not found.",
        request_id: "req-404",
        details: { resource: "resource", id: null }
      }
    })
  }
})

test("OpenAPI document scopes 400/422 errors only to endpoints with request inputs", () => {
  const spec = OpenApi.fromApi(Api)
  const task = spec.components.schemas["Task"] as { required: string[] }
  expect(task.required).toContain("assignee_id")

  const tasksCollection = spec.paths["/projects/{project_id}/tasks"]!
  const taskItem = spec.paths["/projects/{project_id}/tasks/{task_id}"]!
  const profile = spec.paths["/users/{user_id}/profile"]!

  expect(Object.keys(tasksCollection.get!.responses)).toEqual(["200", "422"])
  expect(Object.keys(tasksCollection.post!.responses)).toEqual(["201", "400", "422", "503"])
  expect(Object.keys(taskItem.get!.responses)).toEqual(["200", "404"])
  expect(Object.keys(taskItem.patch!.responses)).toEqual(["200", "400", "404", "422", "503"])
  expect(Object.keys(taskItem.delete!.responses)).toEqual(["204", "404"])
  expect(Object.keys(profile.get!.responses)).toEqual(["200"])
  expect(Object.keys(profile.put!.responses)).toEqual(["200", "400", "422"])
})

test("scoped writes return NotFound on racy delete and ignore cross-project updates", async () => {
  const RacyRepoLive = Layer.effect(
    TasksRepo,
    Effect.gen(function*() {
      const real = yield* TasksRepo
      const sql = yield* SqlClient.SqlClient
      return TasksRepo.of({
        ...real,
        findInProject: (projectId, id) =>
          real.findInProject(projectId, id).pipe(
            Effect.tap(() => sql`DELETE FROM tasks WHERE id = ${id}`)
          )
      })
    })
  ).pipe(Layer.provide(TasksRepo.layer))

  const layer = Tasks.layer.pipe(
    Layer.provideMerge(RacyRepoLive),
    Layer.provide(Access.layer),
    Layer.provide(SqlLive),
    Layer.provide([AppConfig.layer, FetchHttpClient.layer]),
    Layer.provide(envLayer({ DATABASE_PATH: ":memory:" }))
  )

  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const tasks = yield* Tasks
      const repo = yield* TasksRepo
      const a = yield* tasks.create(project, member, { title: "Launch" })
      const b = yield* tasks.create(other, member, { title: "Elsewhere" })
      const racyPatch = yield* Effect.flip(tasks.update(project, a.id, { status: "done" }))
      const missingDelete = yield* Effect.flip(tasks.remove(project, a.id))
      const crossUpdate = yield* repo.updateInProject(
        yield* Task.update.makeEffect({
          id: b.id,
          project_id: project,
          title: "Moved",
          status: b.status,
          assignee_id: b.assignee_id,
          created_by: b.created_by
        }).pipe(Effect.orDie)
      )
      return {
        racyPatch: racyPatch._tag,
        missingDelete: missingDelete._tag,
        crossUpdate: Option.getOrUndefined(crossUpdate)
      }
    }).pipe(Effect.provide(layer))
  )

  expect(result).toEqual({
    racyPatch: "NotFound",
    missingDelete: "NotFound",
    crossUpdate: undefined
  })
})
