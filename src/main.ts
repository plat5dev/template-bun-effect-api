import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { AppConfig } from "./AppConfig.js"
import { PublicHttpLive } from "./Http.js"
import { InternalHttpLive } from "./InternalHttp.js"
import { LifecycleLive } from "./Lifecycle.js"
import { SqlLive } from "./Sql.js"
import { TelemetryLive } from "./Telemetry.js"

const ensureDataDir = Effect.gen(function*() {
  const config = yield* AppConfig
  yield* Effect.promise(() => mkdir(dirname(config.databasePath), { recursive: true }))
})

const MainLive = Layer.mergeAll(PublicHttpLive, InternalHttpLive, LifecycleLive).pipe(
  Layer.provide(SqlLive),
  Layer.provide(TelemetryLive),
  Layer.tap(() =>
    Effect.gen(function*() {
      const config = yield* AppConfig
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "starting api server",
          port: config.port,
          internal_port: config.internalPort
        })
      )
    })
  )
)

// SIGINT or SIGTERM interrupts it (runMain): both servers shut down, and so does the
// lifecycle reader, its read in flight cancelled. The reader ends before SQL closes, since
// layers are released in reverse order.
const program = ensureDataDir.pipe(
  Effect.andThen(Layer.launch(MainLive)),
  Effect.provide(AppConfig.Live),
  Effect.scoped
)

BunRuntime.runMain(program)
