import { expect, onTestFinished, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppConfig } from "./Config.js"
import { SqlLive } from "./Sql.js"
import { envLayer } from "./testing.js"

test("feed_cursors holds one cursor, and migrating again keeps it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "api-db-"))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))

  const dbLayer = SqlLive.pipe(
    Layer.provide(AppConfig.layer),
    Layer.provide(envLayer({
      DATABASE_PATH: join(dir, "app.db")
    }))
  )

  const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromiseExit(effect.pipe(Effect.provide(dbLayer)))

  const first = await withDb(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO feed_cursors (id, event_id) VALUES (1, '813')`.pipe(
        Effect.andThen(sql`INSERT INTO feed_cursors (id, event_id) VALUES (2, '814')`.pipe(Effect.exit))
      ))
  )
  expect(Exit.isSuccess(first) && Exit.isFailure(first.value)).toBe(true)

  const rows = await withDb(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT id, event_id FROM feed_cursors`)
  )
  expect(rows).toEqual(Exit.succeed([{ id: 1, event_id: "813" }]))
})
