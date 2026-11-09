import { BunServices } from "@effect/platform-bun"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { fromFileSystem } from "effect/sql/MigratorFileSystem"
import { fileURLToPath } from "node:url"
import { AppConfig } from "./AppConfig.js"

const ClientLive = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AppConfig
    return SqliteClient.layer({ filename: config.databasePath, create: true })
  })
)

// Each file in ./migrations is one migration, `<id>_<name>.ts`, run once in id order.
const MigratorLive = SqliteMigrator.layer({
  loader: fromFileSystem(fileURLToPath(new URL("./migrations", import.meta.url)))
}).pipe(Layer.provide(BunServices.layer))

/** The SQLite client, migrated. */
export const SqlLive = MigratorLive.pipe(
  Layer.provideMerge(ClientLive),
  Layer.provide(AppConfig.layer)
)
