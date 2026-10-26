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
  yield* sql`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      environment_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS tasks_environment_id_idx
    ON tasks (environment_id)
  `

  // The last lifecycle event acted on: one row, an opaque decimal string.
  yield* sql`
    CREATE TABLE IF NOT EXISTS lifecycle_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      event_id TEXT NOT NULL
    )
  `
})
