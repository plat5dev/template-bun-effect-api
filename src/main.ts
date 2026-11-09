import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path } from "effect"
import { AppConfig } from "./AppConfig.js"
import { PublicHttpLive } from "./Http.js"
import { InternalHttpLive } from "./InternalHttp.js"
import { LifecycleLive } from "./Lifecycle.js"
import * as Log from "./plat5/Log.js"
import { SqlLive } from "./Sql.js"
import { TelemetryLive } from "./Telemetry.js"

/** The database's directory, made if it's missing. */
const ensureDataDir = Effect.gen(function*() {
  const config = yield* AppConfig
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(config.databasePath), { recursive: true })
}).pipe(Effect.provide(BunServices.layer))

const MainLive = Layer.mergeAll(PublicHttpLive, InternalHttpLive, LifecycleLive).pipe(
  Layer.provide(SqlLive),
  Layer.provide(TelemetryLive),
  Layer.tap(() =>
    Effect.gen(function*() {
      const config = yield* AppConfig
      yield* Effect.logInfo("starting api server").pipe(
        Effect.annotateLogs({ port: config.port, internal_port: config.internalPort })
      )
    })
  )
)

// SIGINT or SIGTERM interrupts it (runMain): both servers shut down, and so does the
// lifecycle reader, its read in flight cancelled. The reader ends before SQL closes, since
// layers are released in reverse order.
const program = ensureDataDir.pipe(
  Effect.andThen(Layer.launch(MainLive)),
  Effect.provide([AppConfig.layer, Log.layer])
)

BunRuntime.runMain(program)
