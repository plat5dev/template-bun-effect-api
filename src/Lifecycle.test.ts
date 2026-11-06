import { FetchHttpClient } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { expect, onTestFinished, spyOn, test } from "bun:test"
import { ConfigProvider, Duration, Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import { Profile } from "./domain/Profile.js"
import { Task, TaskId } from "./domain/Task.js"
import { consumer, decodePage, type Event, TYPES } from "./Lifecycle.js"
import { ProfilesRepo } from "./Profiles/Repo.js"
import { SqlLive } from "./Sql.js"
import { TasksRepo } from "./Tasks/Repo.js"

const purged = "01jd8x3k7q0000000000000001"
const kept = "01jd8x3k7q0000000000000002"
const gone = "01jd8x3k7q00000000000000u1"
const stays = "01jd8x3k7q00000000000000u2"
const fresh = "01jd8x3k7q00000000000000u3"

type Served = Partial<Event> & { id: string; type: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Identity, serving the one lifecycle log at /internal/events as identity does: types
 * filters, two events to a page, no after is answered at once, and with after it waits for
 * a matching event up to `wait` ms, then answers 204. The first requests answer `fail`'s
 * statuses, one each.
 */
const serveIdentity = (events: Served[] = []) => {
  const identity = {
    wait: 50,
    /** Statuses for the first requests. */
    fail: [] as number[],
    /** Each request's after, types and limit. */
    asked: [] as string[],
    types: [] as string[],
    limits: [] as string[],
    url: "",
    /** Appends an event and wakes any waiting read. */
    add(event: Served) {
      events.push(event)
      for (const wake of [...added]) wake()
    },
    /** Resolves when a read is next waiting. */
    nextWait: () => new Promise<void>((resolve) => waiting.push(resolve))
  }
  const added = new Set<() => void>()
  const waiting: (() => void)[] = []

  /** The events after `after` that match `types`, at most two, and whether more follow. */
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
      if (failure !== undefined) return new Response(null, { status: failure })
      let answer = page(after, types)
      const deadline = performance.now() + identity.wait
      while (after !== "" && answer.events.length === 0) {
        const left = deadline - performance.now()
        const outcome = await new Promise<"added" | "timeout" | "closed">((resolve) => {
          const done = (outcome: "added" | "timeout" | "closed") => {
            added.delete(onAdd)
            clearTimeout(timer)
            req.signal.removeEventListener("abort", onClose)
            resolve(outcome)
          }
          const onAdd = () => done("added")
          const onClose = () => done("closed")
          const timer = setTimeout(() => done("timeout"), Math.max(0, left))
          added.add(onAdd)
          req.signal.addEventListener("abort", onClose)
          // Tell a test the read is waiting, if it's listening.
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

const StoresLive = Layer.mergeAll(SqlLive, TasksRepo.Default, ProfilesRepo.Default, FetchHttpClient.layer)

const setup = async (identity: Identity, retry: Duration.DurationInput = Duration.millis(10)) => {
  // The consumer's lines, to read and to keep out of the test output.
  const logs = spyOn(console, "log").mockImplementation(() => {})
  onTestFinished(() => logs.mockRestore())
  const scope = Effect.runSync(Scope.make())
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const context = await Effect.runPromise(
    Layer.buildWithScope(StoresLive, scope).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([["DATABASE_PATH", ":memory:"], ["TASK_ASSIGNEE_PERMISSION", "project:read"]])
        )
      )
    )
  )
  const exec = <A, E>(
    effect: Effect.Effect<A, E, SqlClient.SqlClient | TasksRepo | ProfilesRepo>
  ) => Effect.runPromise(Effect.provide(effect, context))
  const c = await exec(consumer(identity.url, retry).pipe(Effect.provide(context)))

  const addTask = (id: string, projectId: string) =>
    exec(Effect.flatMap(TasksRepo, (tasks) =>
      tasks.insert(Task.insert.make({
        id: TaskId.make(id),
        project_id: projectId,
        title: "t",
        status: "todo",
        assignee_id: null,
        created_by: "01jd8x3k7q00000000000000mm",
        created_at: "now",
        updated_at: "now"
      }))))
  const count = (projectId: string) =>
    exec(Effect.flatMap(TasksRepo, (tasks) =>
      tasks.listByProject(projectId, { limit: 100, startingAfter: "" }).pipe(
        Effect.map((page) => page.items.length)
      )))
  const addProfile = (userId: string) =>
    exec(Effect.flatMap(ProfilesRepo, (profiles) =>
      profiles.insert(
        Profile.insert.make({ user_id: userId, bio: "hi", created_at: "now", updated_at: "now" })
      )))
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
    // user.created makes nothing: a profile is made on the person's first call.
    expect(await hasProfile(fresh)).toBe(false)
  }

  /** Forks the consumer's run; `stop` interrupts it, failing unless it ends within 2 s. */
  const start = () => {
    const fiber = Effect.runFork(c.run)
    const stop = async () => {
      const ended = await Effect.runPromise(
        Fiber.interrupt(fiber).pipe(Effect.timeoutOption(Duration.seconds(2)))
      )
      expect(Option.isSome(ended)).toBe(true)
    }
    return stop
  }

  /** Runs the consumer until `cond` holds, then stops it and waits for it to end. */
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
    step: () => Effect.runPromise(c.step),
    stepExit: () => Effect.runPromiseExit(c.step),
    run: c.run,
    cursor: () => Effect.runPromise(c.cursor),
    start,
    runUntil,
    count,
    hasProfile,
    addProfile,
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

test("acts on each page and advances the cursor", async () => {
  const identity = theLog()
  const s = await setup(identity)
  await s.seed()

  // No cursor yet: from the first event, then from each page's last id.
  for (let i = 0; i < 2; i++) {
    expect(await s.step()).toBe(true)
  }
  await s.checkActed()
  expect(await s.cursor()).toBe("13")
  expect(identity.asked).toEqual(["", "12"])
  expect(TYPES).toBe("node.purged,user.deleted")
  expect(identity.types.every((types) => types === TYPES)).toBe(true)
  expect(identity.limits.every((limit) => limit === "100")).toBe(true)
})

test("a 204 is asked again at once", async () => {
  const identity = theLog()
  const s = await setup(identity)
  await s.step()
  await s.step()

  // At the head: identity waits, answers 204, and nothing changes.
  expect(await s.step()).toBe(true)
  expect(await s.cursor()).toBe("13")
  expect(identity.asked.at(-1)).toBe("13")
})

test("a waiting read gets a new event", async () => {
  const identity = theLog()
  identity.wait = 5_000
  const s = await setup(identity)
  await s.step()
  await s.step()

  void (async () => {
    await identity.nextWait()
    identity.add({ id: "21", type: "node.created" }) // not asked for: the wait goes on
    await identity.nextWait()
    identity.add({ id: "22", type: "user.deleted", user_id: stays })
  })()
  const started = performance.now()
  await s.step()
  expect(performance.now() - started).toBeLessThan(2_000)
  expect(await s.hasProfile(stays)).toBe(false)
  expect(await s.cursor()).toBe("22")
})

test("an error is retried", async () => {
  const identity = theLog()
  // Identity's Postgres unavailable is a 503; any other failure, a 500.
  identity.fail = [503, 500]
  const s = await setup(identity)
  await s.seed()

  expect(Exit.isFailure(await s.stepExit())).toBe(true)
  expect(await s.cursor()).toBe("")

  // run logs the 500, waits its retry, and reads on.
  await s.runUntil(async () => (await s.cursor()) === "13")
  await s.checkActed()
  expect(identity.asked.slice(0, 4)).toEqual(["", "", "", "12"])
  const failures = s.logged().filter((line) => line.message === "lifecycle read failed")
  expect(failures.map((line) => [line.level, line.error_message])).toEqual([
    ["error", "lifecycle log answered 500"]
  ])
})

test("an empty log is not asked in a tight loop", async () => {
  const identity = serveIdentity()
  const s = await setup(identity, Duration.millis(50))
  // An immediate empty answer waits before asking again.
  expect(await s.step()).toBe(false)
  await Effect.runPromise(Effect.race(s.run, Effect.sleep(Duration.millis(120))))
  expect(identity.asked.length).toBeLessThanOrEqual(5)
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

test("replay changes nothing", async () => {
  const identity = theLog()
  const s = await setup(identity)
  await s.seed()
  await s.runUntil(async () => (await s.cursor()) === "13")

  // Reset the cursor, as the README says, and read the log again from its first event.
  await s.sqlExec("DELETE FROM feed_cursors")
  const before = identity.asked.length
  await s.runUntil(async () => (await s.cursor()) === "13")
  await s.checkActed()
  expect(identity.asked[before]).toBe("")
  const started = s.logged().filter((line) =>
    line.message === "following the lifecycle log from its first event"
  )
  expect(started.length).toBe(2)
})

test("a page commits with its cursor", async () => {
  const identity = theLog()
  const s = await setup(identity)
  await s.seed()
  // The cursor can't be saved, so the page's deletes roll back with it.
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

test("a page as Go decodes it", () => {
  expect(decodePage({ events: [] })).toEqual([])
  const events = decodePage({
    events: [{ id: "7", Type: "node.purged", kind: null, extra: 1 }, null],
    has_more: "ignored"
  })
  expect(events).toEqual([
    { id: "7", type: "node.purged", kind: "", node_id: "", user_id: "" },
    { id: "", type: "", kind: "", node_id: "", user_id: "" }
  ])
  for (const page of [[], null, {}, { events: null }, { events: {} }, { events: [{ id: 7 }] }, { events: ["x"] }]) {
    expect(() => decodePage(page)).toThrow()
  }
})
