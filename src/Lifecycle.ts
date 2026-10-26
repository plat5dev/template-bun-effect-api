/**
 * Follows identity's lifecycle feed, so the API's data goes when its environment does
 * (plat5 docs/concepts/lifecycle.md#lifecycle-events).
 *
 * The only event it acts on is `node.purged` for an environment: that environment's tasks
 * are deleted. A purged project's environments are purged with it, each with its own
 * event. Tasks are authored, so `member.removed` keeps them, and there is no background
 * work to stop on `node.deleted`. The cursor is the last event id acted on, kept in SQLite
 * and advanced after acting; acting again on the same event changes nothing.
 */
import { FetchHttpClient, HttpClient, HttpClientResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Cause, Duration, Effect, Layer, Schedule, Schema } from "effect"
import { AppConfig } from "./AppConfig.js"
import { trackDb } from "./plat5/DbMetrics.js"
import { SqlLive } from "./Sql.js"
import { TasksRepo } from "./Tasks/Repo.js"

/** The time between polls while the feed is caught up. */
export const INTERVAL = Duration.seconds(5)
const PAGE_SIZE = 100

/** The part of a lifecycle event the API reads. */
const LifecycleEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  kind: Schema.optional(Schema.String),
  node_id: Schema.optional(Schema.String)
})
type LifecycleEvent = typeof LifecycleEvent.Type

const FeedPage = Schema.Struct({
  lifecycle_events: Schema.Array(LifecycleEvent),
  has_more: Schema.Boolean
})

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

/** Reads the feed at `identityUrl`, identity's internal base URL. */
const consumer = (identityUrl: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const tasks = yield* TasksRepo
    // A poll every few seconds isn't a request worth a trace.
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.withTracerDisabledWhen(() => true)
    )
    const feedUrl = `${identityUrl}/internal/lifecycle-events`

    /** The last event id acted on, or "" before the first. */
    const cursor = sql<{ event_id: string }>`
      SELECT event_id FROM lifecycle_cursor WHERE id = 1
    `.pipe(
      Effect.map((rows) => rows[0]?.event_id ?? ""),
      trackDb("lifecycle_cursor.find")
    )

    const saveCursor = (eventId: string) =>
      sql`
        INSERT INTO lifecycle_cursor (id, event_id) VALUES (1, ${eventId})
        ON CONFLICT (id) DO UPDATE SET event_id = excluded.event_id
      `.pipe(Effect.asVoid, trackDb("lifecycle_cursor.save"))

    const fetchPage = (after: string) =>
      client.get(feedUrl, {
        urlParams: after === ""
          ? { limit: PAGE_SIZE }
          : { limit: PAGE_SIZE, starting_after: after }
      }).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(FeedPage)),
        Effect.scoped,
        Effect.timeout(Duration.seconds(10))
      )

    const act = (event: LifecycleEvent) =>
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

    /**
     * Reads from the cursor until the feed has no more, acting on each page and then
     * advancing the cursor past it.
     */
    const poll = Effect.gen(function*() {
      let after = yield* cursor
      for (;;) {
        const page = yield* fetchPage(after)
        yield* Effect.forEach(page.lifecycle_events, act, { discard: true })
        const last = page.lifecycle_events.at(-1)
        if (last) {
          after = last.id
          yield* saveCursor(after)
        }
        if (!page.has_more) return
      }
    })

    // A failed poll is logged and tried again on the next tick.
    return poll.pipe(
      Effect.catchAllCause((cause) => {
        const err = Cause.squash(cause)
        return log("error", "lifecycle poll failed", {
          error_message: err instanceof Error ? err.message : String(err)
        })
      }),
      Effect.repeat(Schedule.spaced(INTERVAL))
    )
  })

/**
 * Polls now and every `INTERVAL` for as long as the app runs. With `IDENTITY_INTERNAL_URL`
 * unset the feed isn't read, and the app says so once at boot.
 */
export const LifecycleLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const config = yield* AppConfig
    if (config.identityInternalUrl === undefined) {
      return Layer.effectDiscard(
        log(
          "warn",
          "IDENTITY_INTERNAL_URL is unset: not reading the lifecycle feed, so a purged environment's tasks are kept"
        )
      )
    }
    return Layer.scopedDiscard(
      consumer(config.identityInternalUrl).pipe(Effect.flatMap(Effect.forkScoped))
    ).pipe(
      Layer.provide(TasksRepo.Default),
      Layer.provide(FetchHttpClient.layer)
    )
  })
).pipe(Layer.provide(SqlLive), Layer.provide(AppConfig.Live))
