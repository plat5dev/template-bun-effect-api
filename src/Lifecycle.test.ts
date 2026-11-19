import { expect, onTestFinished, spyOn, test } from "bun:test"
import { Duration, Effect, Exit, Fiber, Layer, Option, Schema, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { AppConfig } from "./Config.js"
import { type Event, makeLifecycle, Page, TYPES } from "./Lifecycle.js"
import * as Log from "./plat5/Log.js"
import { Profile, ProfilesRepo } from "./Profiles.js"
import { SqlLive } from "./Sql.js"
import { Task, TaskId, TasksRepo } from "./Tasks.js"
import { envLayer } from "./testing.js"

const purged = "01jd8x3k7q0000000000000001"
const kept = "01jd8x3k7q0000000000000002"
const gone = "01jd8x3k7q00000000000000u1"
const stays = "01jd8x3k7q00000000000000u2"
const fresh = "01jd8x3k7q00000000000000u3"

type Served = Partial<Event> & { id: string; type: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const serveIdentity = (events: Served[] = []) => {
  const identity = {
    wait: 50,
    fail: [] as Array<{ status: number; body?: unknown }>,
    asked: [] as string[],
    types: [] as string[],
    limits: [] as string[],
    url: "",
    add(event: Served) {
      events.push(event)
      for (const wake of [...added]) wake()
    },
    nextWait: () => new Promise<void>((resolve) => waiting.push(resolve))
  }
  const added = new Set<() => void>()
  const waiting: (() => void)[] = []

  const page = (after: string, types: string[]) => {
    const match = events.filter((e) => Number(e.id) > Number(after) && types.includes(e.type))
    return { events: match.slice(0, 2), has_more: match.length > 2 }
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== "/internal/events") return new Response(null, { status: 404 })
      const after = url.searchParams.get("after") ?? ""
      const types = (url.searchParams.get("types") ?? "").split(",")
      identity.asked.push(after)
      identity.types.push(url.searchParams.get("types") ?? "")
      identity.limits.push(url.searchParams.get("limit") ?? "")
      const failure = identity.fail.shift()
      if (failure !== undefined) {
        return failure.body !== undefined
          ? Response.json(failure.body, { status: failure.status })
          : new Response(null, { status: failure.status })
      }
      const newest = Math.max(0, ...events.map((e) => Number(e.id)))
      if (after !== "" && Number(after) > newest) {
        return Response.json(
          { error: { type: "invalid_request_error", code: "CURSOR_AHEAD", message: "Cursor ahead." } },
          { status: 409 }
        )
      }
      let answer = page(after, types)
      const deadline = performance.now() + identity.wait
      while (answer.events.length === 0) {
        const left = deadline - performance.now()
        const outcome = await new Promise<"added" | "timeout" | "closed">((resolve) => {
          const done = (result: "added" | "timeout" | "closed") => {
            added.delete(onAdd)
            clearTimeout(timer)
            req.signal.removeEventListener("abort", onClose)
            resolve(result)
          }
          const onAdd = () => done("added")
          const onClose = () => done("closed")
          const timer = setTimeout(() => done("timeout"), Math.max(0, left))
          added.add(onAdd)
          req.signal.addEventListener("abort", onClose)
          waiting.shift()?.()
        })
        if (outcome === "closed") return new Response(null, { status: 499 })
        if (outcome === "timeout") return new Response(null, { status: 204 })
        answer = page(after, types)
      }
      return Response.json(answer)
    }
  })
  onTestFinished(() => server.stop(true))
  identity.url = `http://127.0.0.1:${server.port}`
  return identity
}

type Identity = ReturnType<typeof serveIdentity>

const setup = async (identity: Identity, url = identity.url, retry: Duration.Input = Duration.millis(10)) => {
  const logs = spyOn(console, "log").mockImplementation(() => {})
  onTestFinished(() => logs.mockRestore())
  const scope = Effect.runSync(Scope.make())
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))

  const TestLayer = Layer.mergeAll(TasksRepo.layer, ProfilesRepo.layer).pipe(
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Log.layer),
    Layer.provide(AppConfig.layer),
    Layer.provide(envLayer({ DATABASE_PATH: ":memory:", TASK_ASSIGNEE_PERMISSION: "project:read" }))
  )

  const context = await Effect.runPromise(Layer.buildWithScope(TestLayer, scope))
  const exec = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | TasksRepo | ProfilesRepo>) =>
    Effect.runPromise(Effect.provide(effect, context))
  const c = await Effect.runPromise(makeLifecycle(url, retry).pipe(Effect.provide(context)))

  const addTask = (id: string, projectId: string) =>
    exec(Effect.flatMap(TasksRepo, (tasks) =>
      Task.insert.makeEffect({
        id: TaskId.make(id),
        project_id: projectId,
        title: "t",
        status: "todo",
        assignee_id: null,
        created_by: "01jd8x3k7q00000000000000mm"
      }).pipe(Effect.orDie, Effect.flatMap(tasks.insert))))
  const count = (projectId: string) =>
    exec(Effect.flatMap(TasksRepo, (tasks) =>
      tasks.listByProject(projectId, { limit: 100, startingAfter: "" }).pipe(
        Effect.map((page) => page.items.length)
      )))
  const addProfile = (userId: string) =>
    exec(Effect.flatMap(ProfilesRepo, (profiles) =>
      Profile.insert.makeEffect({ user_id: userId, bio: "hi" }).pipe(Effect.orDie, Effect.flatMap(profiles.upsert))))
  const hasProfile = (userId: string) =>
    exec(Effect.flatMap(ProfilesRepo, (profiles) =>
      profiles.findByUserId(userId).pipe(Effect.map(Option.isSome))))
  const sqlExec = (statement: string) =>
    exec(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)))
  const logged = (): Record<string, unknown>[] =>
    logs.mock.calls.map((call) => JSON.parse(String(call[0])))

  const seed = async () => {
    await addTask("01jd8x3k7q0000000000000t01", purged)
    await addTask("01jd8x3k7q0000000000000t02", kept)
    await addProfile(gone)
    await addProfile(stays)
  }
  const checkActed = async () => {
    expect(await count(purged)).toBe(0)
    expect(await count(kept)).toBe(1)
    expect(await hasProfile(gone)).toBe(false)
    expect(await hasProfile(stays)).toBe(true)
    expect(await hasProfile(fresh)).toBe(false)
  }

  const start = () => {
    const fiber = Effect.runFork(c.run.pipe(Effect.provide(Log.layer)))
    return async () => {
      const ended = await Effect.runPromise(
        Fiber.interrupt(fiber).pipe(Effect.timeoutOption(Duration.seconds(2)))
      )
      expect(Option.isSome(ended)).toBe(true)
    }
  }

  const runUntil = async (cond: () => Promise<boolean>) => {
    const stop = start()
    const deadline = performance.now() + 5_000
    while (!(await cond())) {
      if (performance.now() > deadline) {
        await stop()
        throw new Error("condition not met in 5s")
      }
      await sleep(5)
    }
    await stop()
  }

  return {
    step: () => Effect.runPromise(c.step.pipe(Effect.provide(Log.layer))),
    stepExit: () => Effect.runPromiseExit(c.step.pipe(Effect.provide(Log.layer))),
    cursor: () => Effect.runPromise(c.cursor),
    start,
    runUntil,
    count,
    hasProfile,
    sqlExec,
    logged,
    seed,
    checkActed
  }
}

const theLog = () =>
  serveIdentity([
    { id: "7", type: "node.created", kind: "project", node_id: purged },
    { id: "8", type: "user.created", user_id: fresh },
    { id: "9", type: "node.purged", kind: "organization", node_id: kept },
    { id: "10", type: "member.removed" },
    { id: "12", type: "node.purged", kind: "project", node_id: purged },
    { id: "13", type: "user.deleted", user_id: gone },
    { id: "20", type: "node.deleted", kind: "project", node_id: kept }
  ])

test("acts on each page, trims trailing slash, and advances the cursor", async () => {
  const identity = theLog()
  const s = await setup(identity, `${identity.url}/`)
  await s.seed()

  for (let i = 0; i < 2; i++) await s.step()
  await s.checkActed()
  expect(await s.cursor()).toBe("13")
  expect(identity.asked).toEqual(["", "12"])
  expect(TYPES).toBe("node.purged,user.deleted")
  expect(identity.types.every((t) => t === TYPES)).toBe(true)
  expect(identity.limits.every((l) => l === "100")).toBe(true)
})

test("204 keeps cursor and re-polls cleanly", async () => {
  const identity = theLog()
  const s = await setup(identity)
  await s.step()
  await s.step()
  await s.step()
  expect(await s.cursor()).toBe("13")
  expect(identity.asked.at(-1)).toBe("13")
})

test("a waiting read receives a newly appended event", async () => {
  const identity = theLog()
  identity.wait = 5_000
  const s = await setup(identity)
  await s.step()
  await s.step()

  void (async () => {
    await identity.nextWait()
    identity.add({ id: "21", type: "node.created" })
    await identity.nextWait()
    identity.add({ id: "22", type: "user.deleted", user_id: stays })
  })()
  const started = performance.now()
  await s.step()
  expect(performance.now() - started).toBeLessThan(2_000)
  expect(await s.hasProfile(stays)).toBe(false)
  expect(await s.cursor()).toBe("22")
})

test("errors are logged and retried", async () => {
  const identity = theLog()
  identity.fail = [{ status: 503 }, { status: 500 }]
  const s = await setup(identity)
  await s.seed()

  expect(Exit.isFailure(await s.stepExit())).toBe(true)
  expect(await s.cursor()).toBe("")

  await s.runUntil(async () => (await s.cursor()) === "13")
  await s.checkActed()
  expect(identity.asked.slice(0, 4)).toEqual(["", "", "", "12"])
  const failures = s.logged().filter((line) => line.message === "lifecycle read failed")
  expect(failures.map((line) => [line.level, line.error_message])).toEqual([
    ["error", "lifecycle log answered 500"]
  ])
})

test("409 resets cursor only when error.code is CURSOR_AHEAD", async () => {
  const identity = theLog()
  identity.fail = [{ status: 409, body: { error: { code: "SOME_OTHER_CONFLICT" } } }]
  const s = await setup(identity)
  await s.seed()
  await s.sqlExec("INSERT INTO feed_cursors (id, event_id) VALUES (1, '99')")

  // Non-CURSOR_AHEAD 409 fails without wiping cursor.
  expect(Exit.isFailure(await s.stepExit())).toBe(true)
  expect(await s.cursor()).toBe("99")

  // Real 409 CURSOR_AHEAD clears cursor and replays from start.
  await s.step()
  expect(await s.cursor()).toBe("")
  expect(s.logged().find((line) => String(line.message).startsWith("the lifecycle log was reset"))).toMatchObject({
    level: "warn",
    after: "99"
  })
  for (let i = 0; i < 2; i++) await s.step()
  await s.checkActed()
  expect(await s.cursor()).toBe("13")
})

test("stopping cancels the read in flight", async () => {
  const identity = theLog()
  identity.wait = 60_000
  const s = await setup(identity)
  await s.step()
  await s.step()

  const waiting = identity.nextWait()
  const stop = s.start()
  await waiting
  await stop()
  expect(s.logged().some((line) => line.level === "error")).toBe(false)
})

test("a page rolls back its deletes when saving the cursor fails", async () => {
  const identity = theLog()
  const s = await setup(identity)
  await s.seed()
  await s.sqlExec(
    "CREATE TRIGGER no_cursor BEFORE INSERT ON feed_cursors BEGIN SELECT RAISE(ABORT, 'no'); END"
  )
  for (let i = 0; i < 2; i++) {
    expect(Exit.isFailure(await s.stepExit())).toBe(true)
  }
  expect(await s.count(purged)).toBe(1)
  expect(await s.hasProfile(gone)).toBe(true)
  expect(await s.cursor()).toBe("")
})

test("Page schema decodes valid pages and rejects invalid shapes", () => {
  const decode = (page: unknown) => Effect.runSyncExit(Schema.decodeUnknownEffect(Page)(page))
  expect(decode({ events: [] })).toEqual(Exit.succeed({ events: [] }))
  expect(decode({ events: [{ id: "7", type: "node.purged", kind: null, extra: 1 }], has_more: false })).toEqual(
    Exit.succeed({ events: [{ id: "7", type: "node.purged", kind: null }] })
  )
  for (const bad of [[], null, {}, { events: null }, { events: [{ id: 7, type: "x" }] }]) {
    expect(Exit.isFailure(decode(bad))).toBe(true)
  }
})
