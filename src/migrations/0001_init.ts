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

  // A project is a Plat5 node: its tasks are keyed by its id, and go when it's purged.
  // assignee_id is a member id in the project's tree, or NULL.
  yield* sql`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      assignee_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS tasks_project_id_idx
    ON tasks (project_id)
  `

  // The last event acted on in identity's lifecycle log: one row, an opaque decimal string.
  // Kept with the data it cleans up, so a restore rewinds both together.
  yield* sql`
    CREATE TABLE IF NOT EXISTS feed_cursors (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      event_id TEXT NOT NULL
    )
  `
})
