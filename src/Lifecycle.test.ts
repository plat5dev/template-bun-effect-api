import { FetchHttpClient } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { expect, onTestFinished, spyOn, test } from "bun:test"
import { ConfigProvider, Effect, Exit, Layer, Option, Scope } from "effect"
import { Profile } from "./domain/Profile.js"
import { Task, TaskId } from "./domain/Task.js"
import { consumer } from "./Lifecycle.js"
import { ProfilesRepo } from "./Profiles/Repo.js"
import { SqlLive } from "./Sql.js"
import { TasksRepo } from "./Tasks/Repo.js"

const purged = "01jd8x3k7q0000000000000001"
const kept = "01jd8x3k7q0000000000000002"
const gone = "01jd8x3k7q00000000000000u1"
const stays = "01jd8x3k7q00000000000000u2"
const fresh = "01jd8x3k7q00000000000000u3"

type Event = { id: string; type: string; [field: string]: string }

/** One feed as identity serves it: its events, two to a page, and each cursor asked for. */
type Served = { key: string; events: Event[]; asked: string[]; fail: boolean }

/** Identity, serving the tree and user feeds at their paths. */
const serveIdentity = (tree: Event[], user: Event[]) => {
  const feeds: Record<string, Served> = {
    "/internal/tree-events": { key: "tree_events", events: tree, asked: [], fail: false },
    "/internal/user-events": { key: "user_events", events: user, asked: [], fail: false }
  }
  const limits: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      const feed = feeds[url.pathname]
      if (!feed) return new Response(null, { status: 404 })
      if (feed.fail) return new Response(null, { status: 503 })
      const after = url.searchParams.get("starting_after") ?? ""
      feed.asked.push(after)
      limits.push(url.searchParams.get("limit") ?? "")
      const rest = feed.events.filter((e) => Number(e.id) > Number(after))
      return Response.json({ [feed.key]: rest.slice(0, 2), has_more: rest.length > 2 })
    }
  })
  onTestFinished(() => server.stop(true))
  return {
    url: `http://127.0.0.1:${server.port}`,
    tree: feeds["/internal/tree-events"]!,
    user: feeds["/internal/user-events"]!,
    limits
  }
}

const StoresLive = Layer.mergeAll(SqlLive, TasksRepo.Default, ProfilesRepo.Default, FetchHttpClient.layer)

const setup = async (tree: Event[], user: Event[]) => {
  // The consumer's lines, to read and to keep out of the test output.
  const logs = spyOn(console, "log").mockImplementation(() => {})
  onTestFinished(() => logs.mockRestore())
  const identity = serveIdentity(tree, user)
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
  const run = <A, E>(
    effect: Effect.Effect<A, E, SqlClient.SqlClient | TasksRepo | ProfilesRepo>
  ) => Effect.runPromise(Effect.provide(effect, context))
  const { poll } = await Effect.runPromise(Effect.provide(consumer(identity.url), context))

  const addTask = (id: string, environmentId: string) =>
    run(Effect.flatMap(TasksRepo, (tasks) =>
      tasks.insert(Task.insert.make({
        id: TaskId.make(id),
        environment_id: environmentId,
        title: "t",
        status: "todo",
        assignee_id: null,
        created_by: "01jd8x3k7q00000000000000mm",
        created_at: "now",
        updated_at: "now"
      }))))
  const count = (environmentId: string) =>
    run(Effect.flatMap(TasksRepo, (tasks) =>
      tasks.listByEnvironment(environmentId, { limit: 100, startingAfter: "" }).pipe(
        Effect.map((page) => page.items.length)
      )))
  const addProfile = (userId: string) =>
    run(Effect.flatMap(ProfilesRepo, (profiles) =>
      profiles.insert(
        Profile.insert.make({ user_id: userId, bio: "hi", created_at: "now", updated_at: "now" })
      )))
  const hasProfile = (userId: string) =>
    run(Effect.flatMap(ProfilesRepo, (profiles) =>
      profiles.findByUserId(userId).pipe(Effect.map(Option.isSome))))
  const cursor = (feed: "tree" | "user") =>
    run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ event_id: string }>`SELECT event_id FROM feed_cursors WHERE feed = ${feed}`.pipe(
        Effect.map((rows) => rows[0]?.event_id ?? "")
      )))
  const forgetCursors = () =>
    run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM feed_cursors`))
  const logged = (): Record<string, unknown>[] =>
    logs.mock.calls.map((call) => JSON.parse(String(call[0])))

  return {
    identity,
    poll: () => Effect.runPromise(poll),
    addTask,
    count,
    addProfile,
    hasProfile,
    cursor,
    forgetCursors,
    logged
  }
}

test("tree feed: a purged environment's tasks go, read from its cursor", async () => {
  const s = await setup(
    [
      { id: "7", type: "node.created", kind: "environment", node_id: purged },
      { id: "8", type: "node.deleted", kind: "environment", node_id: kept },
      { id: "9", type: "member.removed", member_id: "01jd8x3k7q00000000000000mm" },
      { id: "10", type: "node.purged", kind: "organization", node_id: kept },
      { id: "11", type: "node.purged", kind: "environment", node_id: purged }
    ],
    []
  )
  await s.addTask("01jd8x3k7q0000000000000t01", purged)
  await s.addTask("01jd8x3k7q0000000000000t02", kept)

  await s.poll()
  expect(await s.count(purged)).toBe(0)
  expect(await s.count(kept)).toBe(1)
  // Three pages in one poll: has_more reads again at once, from each page's last id.
  expect(s.identity.tree.asked).toEqual(["", "8", "10"])
  expect(s.identity.limits.every((limit) => limit === "100")).toBe(true)
  expect(await s.cursor("tree")).toBe("11")

  // The next poll starts from the saved cursor.
  await s.poll()
  expect(s.identity.tree.asked.at(-1)).toBe("11")
})

test("user feed: user.deleted deletes that profile, from the user cursor", async () => {
  const s = await setup(
    [{ id: "900", type: "node.created", kind: "environment", node_id: kept }],
    [
      { id: "1", type: "user.created", user_id: fresh },
      { id: "2", type: "user.deleted", user_id: gone },
      { id: "3", type: "user.created", user_id: stays }
    ]
  )
  await s.addProfile(gone)
  await s.addProfile(stays)

  await s.poll()
  expect(await s.hasProfile(gone)).toBe(false)
  expect(await s.hasProfile(stays)).toBe(true)
  // user.created makes nothing: a profile is made on the person's first call.
  expect(await s.hasProfile(fresh)).toBe(false)
  expect(s.identity.user.asked).toEqual(["", "2"])
  expect(await s.cursor("tree")).toBe("900")
  expect(await s.cursor("user")).toBe("3")

  // Each feed is asked from its own cursor.
  await s.poll()
  expect(s.identity.tree.asked.at(-1)).toBe("900")
  expect(s.identity.user.asked.at(-1)).toBe("3")
})

for (const failing of ["tree", "user"] as const) {
  test(`the ${failing} feed failing doesn't stop the other`, async () => {
    const s = await setup(
      [{ id: "5", type: "node.purged", kind: "environment", node_id: purged }],
      [{ id: "6", type: "user.deleted", user_id: gone }]
    )
    s.identity[failing].fail = true
    await s.addTask("01jd8x3k7q0000000000000t01", purged)
    await s.addProfile(gone)

    await s.poll()
    expect(await s.count(purged)).toBe(failing === "tree" ? 1 : 0)
    expect(await s.hasProfile(gone)).toBe(failing === "user")
    // The failed feed keeps its cursor, to be read again on the next poll, and the log says
    // which feed failed.
    expect(await s.cursor(failing)).toBe("")
    const failures = s.logged().filter((line) => line.message === "lifecycle poll failed")
    expect(failures.map((line) => [line.level, line.feed])).toEqual([["error", failing]])
  })
}

test("reading an event twice is harmless", async () => {
  const s = await setup(
    [{ id: "3", type: "node.purged", kind: "environment", node_id: purged }],
    [{ id: "4", type: "user.deleted", user_id: gone }]
  )
  await s.addTask("01jd8x3k7q0000000000000t01", purged)
  await s.addProfile(gone)

  for (let i = 0; i < 2; i++) {
    await s.poll()
    // Forget the cursors, so the next poll gets the same events.
    await s.forgetCursors()
  }
  expect(await s.count(purged)).toBe(0)
  expect(await s.hasProfile(gone)).toBe(false)
  expect(s.identity.tree.asked).toEqual(["", ""])
  expect(s.identity.user.asked).toEqual(["", ""])
  expect(s.logged().some((line) => line.level === "error")).toBe(false)
})
