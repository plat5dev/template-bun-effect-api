import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  // The person's name is identity's directory name, not this service's.
  yield* sql`
    CREATE TABLE IF NOT EXISTS profiles (
      user_id TEXT PRIMARY KEY NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  // An environment is a Plat5 node: its tasks are keyed by its id, and go when it's purged.
  // assignee_id is a member id in the environment's tree, or NULL.
  yield* sql`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      environment_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      assignee_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS tasks_environment_id_idx
    ON tasks (environment_id)
  `

  // The last event acted on in each of identity's feeds: one row per feed, an opaque
  // decimal string from that feed's own sequence.
  yield* sql`
    CREATE TABLE IF NOT EXISTS feed_cursors (
      feed TEXT PRIMARY KEY NOT NULL CHECK (feed IN ('tree', 'user')),
      event_id TEXT NOT NULL
    )
  `
})
