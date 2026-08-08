import { BunContext } from "@effect/platform-bun"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"
import { AppConfig } from "./AppConfig.js"

const ClientLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const config = yield* AppConfig
    return SqliteClient.layer({
      filename: config.databasePath,
      create: true
    })
  })
)

const MigratorLive = SqliteMigrator.layer({
  loader: SqliteMigrator.fromFileSystem(
    fileURLToPath(new URL("./migrations", import.meta.url))
  )
}).pipe(Layer.provide(BunContext.layer))

export const SqlLive = MigratorLive.pipe(
  Layer.provideMerge(ClientLive),
  Layer.provide(AppConfig.Live)
)
