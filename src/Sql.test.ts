import { SqlClient } from "@effect/sql"
import { expect, onTestFinished, test } from "bun:test"
import { ConfigProvider, Effect, Exit } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqlLive } from "./Sql.js"

test("feed_cursors holds one cursor, and migrating again keeps it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "api-db-"))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromiseExit(
      effect.pipe(
        Effect.provide(SqlLive),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["DATABASE_PATH", join(dir, "app.db")],
              ["TASK_ASSIGNEE_PERMISSION", "project:read"]
            ])
          )
        )
      )
    )

  const first = await withDb(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO feed_cursors (id, event_id) VALUES (1, '813')`.pipe(
        Effect.zipRight(sql`INSERT INTO feed_cursors (id, event_id) VALUES (2, '814')`.pipe(Effect.exit))
      ))
  )
  // A second cursor isn't taken.
  expect(Exit.isSuccess(first) && Exit.isFailure(first.value)).toBe(true)

  // Migrating again keeps the cursor.
  const rows = await withDb(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT id, event_id FROM feed_cursors`)
  )
  expect(rows).toEqual(Exit.succeed([{ id: 1, event_id: "813" }]))
})
