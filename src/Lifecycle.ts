/**
 * Follows identity's lifecycle log, so the API's data goes when its project or its
 * person does (plat5 docs/concepts/lifecycle.md#following-the-log).
 *
 * It asks only for the two events it acts on. `node.purged` for a project deletes that
 * project's tasks; a purged organization's projects are purged with it, each with its own
 * event. `user.deleted` deletes that person's profile. Tasks are authored, so
 * `member.removed` keeps them. One cursor, the last event id acted on, is kept in SQLite
 * with the data it cleans up, and saved in the same transaction as a page's deletes. Acting
 * again on the same event changes nothing, so the log can be replayed by resetting it.
 */
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpIncomingMessage } from "effect/http"
import { SqlClient } from "effect/sql"
import { AppConfig } from "./AppConfig.js"
import { trackDb } from "./plat5/DbMetrics.js"
import { ProfilesRepo } from "./Profiles/Repo.js"
import { SqlLive } from "./Sql.js"
import { TasksRepo } from "./Tasks/Repo.js"

/** The events the API acts on, and the only ones it asks for. */
export const TYPES = "node.purged,user.deleted"
/** The wait after a failed read before asking again. */
export const RETRY_AFTER = Duration.seconds(5)
/** Identity waits up to 25 s before a 204, so a read may take that long. */
const REQUEST_TIMEOUT = Duration.seconds(40)
const PAGE_SIZE = 100

const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String))

/** The part of an event the API reads (plat5 docs/reference/api/internal.md#lifecycle-events). */
export const Event = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  kind: OptionalText,
  node_id: OptionalText,
  user_id: OptionalText
})
export type Event = typeof Event.Type

/** A page of the log: its events. */
export const Page = Schema.Struct({ events: Schema.Array(Event) })

/** Reading or acting on the log failed: logged, and asked again later. */
export class LifecycleError extends Schema.TaggedError<LifecycleError>()("LifecycleError", {
  message: Schema.String
}) {}

const logAt = { info: Effect.logInfo, warn: Effect.logWarning, error: Effect.logError } as const

/** A lifecycle line: `component: lifecycle`, then `fields`. */
const log = (level: keyof typeof logAt, message: string, fields: Record<string, unknown> = {}) =>
  logAt[level](message).pipe(Effect.annotateLogs({ component: "lifecycle", ...fields }))

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * The log's reader, on `identityUrl`, identity's internal base URL. `retry` is the wait after
 * an error, or after an immediate answer with no events.
 */
export class Lifecycle extends Context.Service<Lifecycle>()("api/Lifecycle", {
  make: Effect.fnUntraced(function*(identityUrl: string, retry: Duration.Input = RETRY_AFTER) {
    const sql = yield* SqlClient.SqlClient
    const tasks = yield* TasksRepo
    const profiles = yield* ProfilesRepo
    // A read held open for up to 25 s isn't a request worth a trace.
    const client = HttpClient.transform(
      yield* HttpClient.HttpClient,
      (effect) => Effect.provideService(effect, HttpClient.TracerDisabledWhen, () => true)
    )
    const url = `${identityUrl}/internal/events`

    /** The last event id acted on, or "" before the first. */
    const cursor = sql<{ event_id: string }>`SELECT event_id FROM feed_cursors WHERE id = 1`.pipe(
      Effect.map((rows) => rows[0]?.event_id ?? ""),
      trackDb("feed_cursors.find")
    )

    const saveCursor = (eventId: string) =>
      sql`
        INSERT INTO feed_cursors (id, event_id) VALUES (1, ${eventId})
        ON CONFLICT (id) DO UPDATE SET event_id = excluded.event_id
      `.pipe(Effect.asVoid, trackDb("feed_cursors.save"))

    /**
     * Asks for the events after `after`, or from the first event when there's none yet.
     * With a cursor identity waits for one; its 204 is no events, and `waited`.
     */
    const fetchPage = (after: string) =>
      client.get(url, {
        urlParams: after === "" ? { types: TYPES, limit: PAGE_SIZE } : { types: TYPES, limit: PAGE_SIZE, after }
      }).pipe(
        Effect.flatMap(HttpClientResponse.matchStatus({
          200: (res) =>
            HttpIncomingMessage.schemaBodyJson(Page)(res).pipe(
              Effect.map((page) => ({ events: page.events, waited: false }))
            ),
          204: () => Effect.succeed({ events: [] as ReadonlyArray<Event>, waited: true }),
          orElse: (res) => Effect.fail(new LifecycleError({ message: `lifecycle log answered ${res.status}` }))
        })),
        Effect.timeout(REQUEST_TIMEOUT)
      )

    const act = (event: Event): Effect.Effect<void> => {
      if (event.type === "node.purged" && event.kind === "project" && event.node_id) {
        return tasks.deleteByProject(event.node_id).pipe(
          Effect.andThen(log("info", "purged project's tasks deleted", { event_id: event.id, node_id: event.node_id }))
        )
      }
      if (event.type === "user.deleted" && event.user_id) {
        return profiles.deleteByUserId(event.user_id).pipe(
          Effect.andThen(log("info", "profile deleted with its account", { event_id: event.id, user_id: event.user_id }))
        )
      }
      return Effect.void
    }

    /**
     * Acts on a page and saves its last id as the cursor in one transaction: the deletes and
     * the cursor commit together or not at all.
     */
    const apply = (events: ReadonlyArray<Event>, last: string) =>
      Effect.forEach(
        events,
        (event) =>
          act(event).pipe(
            Effect.catchDefect((defect) =>
              Effect.fail(new LifecycleError({ message: `event ${event.id}: ${messageOf(defect)}` }))
            )
          ),
        { discard: true }
      ).pipe(Effect.andThen(saveCursor(last)), sql.withTransaction)

    /**
     * Asks once for the events after the saved cursor, acts on them, and saves the cursor
     * past them in the same transaction as their deletes. Succeeds with whether to ask again
     * at once: after a page of events, or a 204 (identity waited and nothing came). A defect
     * is a failure, so it is logged and retried like one.
     */
    const step = Effect.gen(function*() {
      const after = yield* cursor
      const { events, waited } = yield* fetchPage(after)
      const last = events.at(-1)
      if (last === undefined) return waited
      yield* apply(events, last.id)
      yield* log("info", "lifecycle page read", { events: events.length, after, cursor: last.id })
      return true
    }).pipe(Effect.catchDefect((defect) => Effect.fail(new LifecycleError({ message: messageOf(defect) }))))

    /** After a page or a 204, ask again at once; after an immediate empty answer, after `retry`. */
    const pace = Schedule.forever.pipe(
      Schedule.passthrough,
      Schedule.addDelay(({ output: again }) => Effect.succeed(again ? Duration.zero : retry))
    )

    /**
     * Follows the log until interrupted, which also cancels a read in flight. An error is
     * logged and the read asked again after `retry`, from the same cursor.
     */
    const run = Effect.gen(function*() {
      // A failure here fails the first step the same way, and is logged there.
      yield* cursor.pipe(
        Effect.flatMap((after) =>
          after === ""
            ? log("info", "following the lifecycle log from its first event")
            : log("info", "following the lifecycle log", { after })
        ),
        Effect.ignore
      )
      return yield* step.pipe(
        Effect.tapError((err) =>
          log("error", "lifecycle read failed", {
            error_message: err.message,
            retry_in_ms: Duration.toMillis(Duration.fromInputUnsafe(retry))
          })
        ),
        Effect.retry(Schedule.spaced(retry)),
        Effect.repeat(pace)
      )
    })

    return { cursor, step, run } as const
  })
}) {}

/**
 * Follows the log for as long as the app runs. Shutting down interrupts it, cancelling a
 * read in flight, and waits for it before the database closes. With
 * `IDENTITY_INTERNAL_URL` unset the log isn't read, and the app says so once at boot.
 */
export const LifecycleLive = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AppConfig
    if (config.identityInternalUrl === undefined) {
      return Layer.effectDiscard(
        log(
          "warn",
          "IDENTITY_INTERNAL_URL is unset: not reading identity's lifecycle log, so a purged project's tasks and a deleted person's profile are kept, and a task's assignee can't be checked (503)"
        )
      )
    }
    return Layer.effectDiscard(
      Lifecycle.make(config.identityInternalUrl).pipe(Effect.flatMap(({ run }) => Effect.forkScoped(run)))
    ).pipe(Layer.provide([TasksRepo.layerNoDeps, ProfilesRepo.layerNoDeps, FetchHttpClient.layer]))
  })
).pipe(Layer.provide(SqlLive), Layer.provide(AppConfig.layer))
