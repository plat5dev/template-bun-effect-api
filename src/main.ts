import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path } from "effect"
import { FetchHttpClient } from "effect/http"
import { Access } from "./Access.js"
import { AppConfig } from "./Config.js"
import { PublicHttpLive } from "./Http.js"
import { InternalHttpLive } from "./InternalHttp.js"
import { LifecycleLive } from "./Lifecycle.js"
import * as Log from "./plat5/Log.js"
import { Profiles, ProfilesRepo } from "./Profiles.js"
import { SqlLive } from "./Sql.js"
import { Tasks, TasksRepo } from "./Tasks.js"
import { TelemetryLive } from "./Telemetry.js"

const ensureDataDir = Effect.gen(function*() {
  const config = yield* AppConfig
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(config.databasePath), { recursive: true })
})

const ReposLive = Layer.mergeAll(TasksRepo.layer, ProfilesRepo.layer)
const ServicesLive = Layer.mergeAll(Profiles.layer, Tasks.layer)

const MainLive = Layer.mergeAll(PublicHttpLive, InternalHttpLive, LifecycleLive).pipe(
  Layer.provide(ServicesLive),
  Layer.provide(Layer.mergeAll(ReposLive, Access.layer)),
  Layer.provide(Layer.mergeAll(SqlLive, TelemetryLive)),
  Layer.provide(FetchHttpClient.layer),
  Layer.tap(() =>
    Effect.gen(function*() {
      const config = yield* AppConfig
      yield* Effect.logInfo("starting api server").pipe(
        Effect.annotateLogs({ port: config.port, internal_port: config.internalPort })
      )
    })
  )
)

const program = ensureDataDir.pipe(
  Effect.andThen(Layer.launch(MainLive)),
  Effect.provide([AppConfig.layer, BunServices.layer, Log.layer])
)

BunRuntime.runMain(program)
