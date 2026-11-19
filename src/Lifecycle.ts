/**
 * Identity lifecycle log consumer (`GET {IDENTITY_INTERNAL_URL}/internal/events`).
 * Deletes a purged project's tasks and a deleted user's profile atomically with `feed_cursors`.
 */
import { Duration, Effect, Layer, Schedule, Schema } from "effect"
import { HttpClient, HttpClientResponse, HttpIncomingMessage } from "effect/http"
import { SqlClient } from "effect/sql"
import { AppConfig } from "./Config.js"
import { ProfilesRepo } from "./Profiles.js"
import { TasksRepo } from "./Tasks.js"

export const TYPES = "node.purged,user.deleted"
export const RETRY_AFTER = Duration.seconds(5)
const REQUEST_TIMEOUT = Duration.seconds(40)
const PAGE_SIZE = 100

const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String))

export const Event = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  kind: OptionalText,
  node_id: OptionalText,
  user_id: OptionalText
})
export type Event = typeof Event.Type

export const Page = Schema.Struct({ events: Schema.Array(Event) })

const ConflictBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.String })
})

export class LifecycleError extends Schema.TaggedError<LifecycleError>()("LifecycleError", {
  message: Schema.String
}) {}

const logAt = { info: Effect.logInfo, warn: Effect.logWarning, error: Effect.logError } as const

const log = (level: keyof typeof logAt, message: string, fields: Record<string, unknown> = {}) =>
  logAt[level](message).pipe(Effect.annotateLogs({ component: "lifecycle", ...fields }))

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const makeLifecycle = Effect.fnUntraced(function*(
  identityUrl: string,
  retry: Duration.Input = RETRY_AFTER
) {
  const sql = yield* SqlClient.SqlClient
  const tasks = yield* TasksRepo
  const profiles = yield* ProfilesRepo
  const client = HttpClient.transform(
    yield* HttpClient.HttpClient,
    (effect) => Effect.provideService(effect, HttpClient.TracerDisabledWhen, () => true)
  )
  const url = `${identityUrl.replace(/\/+$/, "")}/internal/events`

  const cursor = sql<{ event_id: string }>`SELECT event_id FROM feed_cursors WHERE id = 1`.pipe(
    Effect.map((rows) => rows[0]?.event_id ?? "")
  )

  const saveCursor = (eventId: string) =>
    sql`
      INSERT INTO feed_cursors (id, event_id) VALUES (1, ${eventId})
      ON CONFLICT (id) DO UPDATE SET event_id = excluded.event_id
    `.pipe(Effect.asVoid)

  const clearCursor = sql`DELETE FROM feed_cursors`.pipe(Effect.asVoid)

  const fetchPage = (after: string) =>
    client.get(url, {
      urlParams: after === "" ? { types: TYPES, limit: PAGE_SIZE } : { types: TYPES, limit: PAGE_SIZE, after }
    }).pipe(
      Effect.flatMap(HttpClientResponse.matchStatus({
        200: (res) => Effect.map(HttpIncomingMessage.schemaBodyJson(Page)(res), (page) => page.events),
        204: () => Effect.succeed([] as ReadonlyArray<Event>),
        409: (res) =>
          HttpIncomingMessage.schemaBodyJson(ConflictBody)(res).pipe(
            Effect.flatMap((body) =>
              body.error.code === "CURSOR_AHEAD"
                ? Effect.succeed("reset" as const)
                : Effect.fail(new LifecycleError({ message: `lifecycle log answered 409 (${body.error.code})` }))
            ),
            Effect.catchTag(["HttpClientError", "SchemaError"], () =>
              Effect.fail(new LifecycleError({ message: "lifecycle log answered 409" }))
            )
          ),
        orElse: (res) => Effect.fail(new LifecycleError({ message: `lifecycle log answered ${res.status}` }))
      })),
      Effect.timeout(REQUEST_TIMEOUT)
    )

  const act = (event: Event) => {
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

  const apply = (events: ReadonlyArray<Event>, last: string) =>
    Effect.forEach(events, act, { discard: true }).pipe(
      Effect.andThen(saveCursor(last)),
      sql.withTransaction
    )

  const step = Effect.gen(function*() {
    const after = yield* cursor
    const page = yield* fetchPage(after)
    if (page === "reset") {
      yield* log("warn", "the lifecycle log was reset: reading it again from its first event", { after })
      return yield* clearCursor
    }
    const last = page.at(-1)
    if (last === undefined) return
    yield* apply(page, last.id)
    yield* log("info", "lifecycle page read", { events: page.length, after, cursor: last.id })
  }).pipe(
    Effect.catchDefect((defect) => Effect.fail(new LifecycleError({ message: messageOf(defect) })))
  )

  const run = Effect.gen(function*() {
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
          error_message: messageOf(err),
          retry_in_ms: Duration.toMillis(Duration.fromInputUnsafe(retry))
        })
      ),
      Effect.retry(Schedule.spaced(retry)),
      Effect.forever
    )
  })

  return { cursor, step, run } as const
})

export const LifecycleLive = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AppConfig
    if (config.identityInternalUrl === undefined) {
      return Layer.effectDiscard(
        log(
          "warn",
          "IDENTITY_INTERNAL_URL is unset: lifecycle log disabled and assignee checks will return 503"
        )
      )
    }
    return Layer.effectDiscard(
      makeLifecycle(config.identityInternalUrl).pipe(Effect.flatMap(({ run }) => Effect.forkScoped(run)))
    )
  })
)
