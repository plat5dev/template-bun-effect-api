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
import { FetchHttpClient, HttpClient, HttpClientResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Cause, Duration, Effect, Layer, Schedule, Schema } from "effect"
import { AppConfig } from "./AppConfig.js"
import { trackDb } from "./plat5/DbMetrics.js"
import { ProfilesRepo } from "./Profiles/Repo.js"
import { SqlLive } from "./Sql.js"
import { TasksRepo } from "./Tasks/Repo.js"

/** The time between polls while the feeds are caught up. */
export const INTERVAL = Duration.seconds(5)
const PAGE_SIZE = 100

/** The part of a tree event the API reads. `kind` and `node_id` are a node event's. */
const TreeEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  kind: Schema.optional(Schema.String),
  node_id: Schema.optional(Schema.String)
})
type TreeEvent = typeof TreeEvent.Type

/** The part of a user event the API reads. */
const UserEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  user_id: Schema.String
})
type UserEvent = typeof UserEvent.Type

/** A feed's page: its events, under the feed's own key, and whether there are more. */
const Page = <A, I, K extends string>(key: K, event: Schema.Schema<A, I>) =>
  Schema.Struct({
    events: Schema.propertySignature(Schema.Array(event)).pipe(Schema.fromKey(key)),
    has_more: Schema.Boolean
  })

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
      HttpClient.filterStatusOk,
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
    const follow = <E extends { readonly id: string }, I>(
      name: FeedName,
      path: string,
      page: Schema.Schema<{ readonly events: ReadonlyArray<E>; readonly has_more: boolean }, I>,
      act: (event: E) => Effect.Effect<void>
    ) => {
      const fetchPage = (after: string) =>
        client.get(`${identityUrl}${path}`, {
          urlParams: after === ""
            ? { limit: PAGE_SIZE }
            : { limit: PAGE_SIZE, starting_after: after }
        }).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(page)),
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

    const actOnTree = (event: TreeEvent) =>
      event.type !== "node.purged" || event.kind !== "environment" || event.node_id === undefined
        ? Effect.void
        : tasks.deleteByEnvironment(event.node_id).pipe(
          Effect.zipRight(
            log("info", "purged environment's tasks deleted", {
              event_id: event.id,
              node_id: event.node_id
            })
          )
        )

    const actOnUser = (event: UserEvent) =>
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
      follow("tree", "/internal/tree-events", Page("tree_events", TreeEvent), actOnTree),
      follow("user", "/internal/user-events", Page("user_events", UserEvent), actOnUser)
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
          poll.pipe(Effect.repeat(Schedule.spaced(INTERVAL)), Effect.forkScoped)
        )
      )
    ).pipe(
      Layer.provide(TasksRepo.Default),
      Layer.provide(ProfilesRepo.Default),
      Layer.provide(FetchHttpClient.layer)
    )
  })
).pipe(Layer.provide(SqlLive), Layer.provide(AppConfig.Live))
