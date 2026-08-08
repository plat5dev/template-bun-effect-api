import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { AppConfig } from "./AppConfig.js"
import { PublicHttpLive } from "./Http.js"
import { InternalHttpLive } from "./InternalHttp.js"
import { SqlLive } from "./Sql.js"
import { TelemetryLive } from "./Telemetry.js"

const ensureDataDir = Effect.gen(function*() {
  const config = yield* AppConfig
  yield* Effect.promise(() => mkdir(dirname(config.databasePath), { recursive: true }))
})

const MainLive = Layer.mergeAll(PublicHttpLive, InternalHttpLive).pipe(
  Layer.provide(SqlLive),
  Layer.provide(TelemetryLive)
)

const program = ensureDataDir.pipe(
  Effect.andThen(Layer.launch(MainLive)),
  Effect.provide(AppConfig.Live),
  Effect.scoped
)

BunRuntime.runMain(program)
