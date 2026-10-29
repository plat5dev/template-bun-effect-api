/**
 * Follows identity's two feeds, so the API's data goes when its environment or its person
 * does (plat5 docs/concepts/lifecycle.md#lifecycle-events).
 *
 * On the tree feed, the only event it acts on is `node.purged` for an environment: that
 * environment's tasks are deleted. A purged project's environments are purged with it,
 * each with its own event. Tasks are authored, so `member.removed` keeps them, and there is
 * no background work to stop on `node.deleted`. On the user feed, the only one is
 * `user.deleted`: that person's profile is deleted. Each feed has its own cursor, the last
 * event id acted on, kept in SQLite and advanced after acting on each page; acting again on
 * the same event changes nothing.
 */
import { FetchHttpClient, HttpClient } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Cause, Duration, Effect, Layer, Schedule } from "effect"
import { AppConfig } from "./AppConfig.js"
import { trackDb } from "./plat5/DbMetrics.js"
import { ProfilesRepo } from "./Profiles/Repo.js"
import { SqlLive } from "./Sql.js"
import { TasksRepo } from "./Tasks/Repo.js"

/** The time between polls while the feeds are caught up. */
export const INTERVAL = Duration.seconds(5)
const PAGE_SIZE = 100

/**
 * The part of an event the API reads: each field a string, "" when absent or null. A tree
 * event's `kind` and `node_id` are a node event's; a user event's `user_id` is its person.
 */
type Event = {
  readonly id: string
  readonly type: string
  readonly kind: string
  readonly node_id: string
  readonly user_id: string
}

const EVENT_FIELDS = ["id", "type", "kind", "node_id", "user_id"] as const

/** An event as read: keys matched ignoring case, a null event all "". Another type is an error. */
const decodeEvent = (raw: unknown): Event => {
  const event: Record<string, string> = { id: "", type: "", kind: "", node_id: "", user_id: "" }
  if (raw === null) return event as Event
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("event is not an object")
  for (const [key, value] of Object.entries(raw)) {
    const name = EVENT_FIELDS.find((n) => n === key || n === key.toLowerCase())
    if (name === undefined || value === null) continue
    if (typeof value !== "string") throw new Error(`event ${name} is not a string`)
    event[name] = value
  }
  return event as Event
}

/**
 * A feed's page: its events under the feed's own `key`, a list or null, and `has_more`, a
 * boolean or null. Either missing, or of another type, is an error.
 */
export const decodePage = (
  feed: string,
  key: string,
  page: unknown
): { readonly events: ReadonlyArray<Event>; readonly has_more: boolean } => {
  if (typeof page !== "object" || page === null || Array.isArray(page)) {
    throw new Error(`${feed} feed: not an object`)
  }
  const p = page as Record<string, unknown>
  const events = p[key]
  if (!(key in p)) throw new Error(`${feed} feed: ${key}: missing`)
  if (events !== null && !Array.isArray(events)) throw new Error(`${feed} feed: ${key}: not a list`)
  if (!("has_more" in p)) throw new Error(`${feed} feed: has_more: missing`)
  const more = p.has_more
  if (more !== null && typeof more !== "boolean") {
    throw new Error(`${feed} feed: has_more: not a boolean`)
  }
  return { events: (events ?? []).map(decodeEvent), has_more: more === true }
}

/** A feed's name: its row in feed_cursors, and its logs' `feed`. */
type FeedName = "tree" | "user"

const log = (level: string, message: string, fields: Record<string, unknown> = {}) =>
  Effect.sync(() =>
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        component: "lifecycle",
        ...fields
      })
    )
  )

/** Reads the feeds at `identityUrl`, identity's internal base URL. */
export const consumer = (identityUrl: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const tasks = yield* TasksRepo
    const profiles = yield* ProfilesRepo
    // A poll every few seconds isn't a request worth a trace.
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatus((status) => status === 200),
      HttpClient.withTracerDisabledWhen(() => true)
    )

    /** The last event id acted on in the feed, or "" before the first. */
    const cursor = (feed: FeedName) =>
      sql<{ event_id: string }>`
        SELECT event_id FROM feed_cursors WHERE feed = ${feed}
      `.pipe(
        Effect.map((rows) => rows[0]?.event_id ?? ""),
        trackDb("feed_cursors.find")
      )

    const saveCursor = (feed: FeedName, eventId: string) =>
      sql`
        INSERT INTO feed_cursors (feed, event_id) VALUES (${feed}, ${eventId})
        ON CONFLICT (feed) DO UPDATE SET event_id = excluded.event_id
      `.pipe(Effect.asVoid, trackDb("feed_cursors.save"))

    /**
     * Reads the feed `name` at `path` from its cursor until it has no more, acting on each
     * page and then advancing the cursor past it. A failure is logged with the feed's name,
     * and the feed is read again on the next poll.
     */
    const follow = (
      name: FeedName,
      path: string,
      key: string,
      act: (event: Event) => Effect.Effect<void>
    ) => {
      const fetchPage = (after: string) =>
        client.get(`${identityUrl}${path}`, {
          urlParams: after === ""
            ? { limit: PAGE_SIZE }
            : { limit: PAGE_SIZE, starting_after: after }
        }).pipe(
          Effect.flatMap((res) => res.json),
          Effect.flatMap((page) => Effect.try(() => decodePage(name, key, page))),
          Effect.scoped,
          Effect.timeout(Duration.seconds(10))
        )

      return Effect.gen(function*() {
        let after = yield* cursor(name)
        for (;;) {
          const { events, has_more } = yield* fetchPage(after)
          yield* Effect.forEach(events, act, { discard: true })
          const last = events.at(-1)
          if (last) {
            after = last.id
            yield* saveCursor(name, after)
          }
          if (!has_more) return
        }
      }).pipe(
        Effect.catchAllCause((cause) => {
          const err = Cause.squash(cause)
          return log("error", "lifecycle poll failed", {
            feed: name,
            error_message: err instanceof Error ? err.message : String(err)
          })
        })
      )
    }

    const actOnTree = (event: Event) =>
      event.type !== "node.purged" || event.kind !== "environment"
        ? Effect.void
        : tasks.deleteByEnvironment(event.node_id).pipe(
          Effect.zipRight(
            log("info", "purged environment's tasks deleted", {
              event_id: event.id,
              node_id: event.node_id
            })
          )
        )

    const actOnUser = (event: Event) =>
      event.type !== "user.deleted"
        ? Effect.void
        : profiles.deleteByUserId(event.user_id).pipe(
          Effect.zipRight(
            log("info", "profile deleted with its account", {
              event_id: event.id,
              user_id: event.user_id
            })
          )
        )

    /**
     * Reads the tree feed to its end, then the user feed. A feed that fails doesn't stop the
     * other.
     */
    const poll = Effect.zipRight(
      follow("tree", "/internal/tree-events", "tree_events", actOnTree),
      follow("user", "/internal/user-events", "user_events", actOnUser)
    )

    return { poll } as const
  })

/**
 * Polls now and every `INTERVAL` for as long as the app runs. With `IDENTITY_INTERNAL_URL`
 * unset neither feed is read, and the app says so once at boot.
 */
export const LifecycleLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const config = yield* AppConfig
    if (config.identityInternalUrl === undefined) {
      return Layer.effectDiscard(
        log(
          "warn",
          "IDENTITY_INTERNAL_URL is unset: not reading identity's feeds, so a purged environment's tasks and a deleted person's profile are kept, and a task's assignee can't be checked (503)"
        )
      )
    }
    return Layer.scopedDiscard(
      consumer(config.identityInternalUrl).pipe(
        Effect.flatMap(({ poll }) =>
          poll.pipe(Effect.repeat(Schedule.fixed(INTERVAL)), Effect.forkScoped)
        )
      )
    ).pipe(
      Layer.provide(TasksRepo.Default),
      Layer.provide(ProfilesRepo.Default),
      Layer.provide(FetchHttpClient.layer)
    )
  })
).pipe(Layer.provide(SqlLive), Layer.provide(AppConfig.Live))
