import { onTestFinished, spyOn } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { FetchHttpClient, HttpMiddleware, HttpRouter, HttpServer } from "effect/http"
import { Access } from "./Access.js"
import { AppConfig } from "./Config.js"
import { publicMiddleware, PublicRoutes } from "./Http.js"
import * as Log from "./plat5/Log.js"
import { Profiles, ProfilesRepo } from "./Profiles.js"
import { SqlLive } from "./Sql.js"
import { Tasks, TasksRepo } from "./Tasks.js"
import { TelemetryLive } from "./Telemetry.js"

export const envLayer = (env: ReadonlyMap<string, string> | Readonly<Record<string, string>>): Layer.Layer<never> =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(env instanceof Map ? Object.fromEntries(env) : env))

/**
 * In-memory public API web handler backed by `:memory:` SQLite, wired once with `HttpRouter.toWebHandler`.
 */
export const makeTestApp = (env: Readonly<Record<string, string>> = {}) => {
  const logs = spyOn(console, "log").mockImplementation(() => {})
  const configEnv = { DATABASE_PATH: ":memory:", TASK_ASSIGNEE_PERMISSION: "project:read", ...env }

  const AppLayer = PublicRoutes.pipe(
    Layer.provide(Layer.mergeAll(Profiles.layer, Tasks.layer)),
    Layer.provide(Layer.mergeAll(TasksRepo.layer, ProfilesRepo.layer, Access.layer)),
    Layer.provide(SqlLive),
    Layer.provideMerge(TelemetryLive),
    Layer.provide([AppConfig.layer, FetchHttpClient.layer, HttpServer.layerServices]),
    Layer.provideMerge(Log.layer),
    Layer.provideMerge(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true)),
    Layer.provide(envLayer(configEnv))
  )

  const app = HttpRouter.toWebHandler(AppLayer, {
    middleware: publicMiddleware,
    disableLogger: true
  })

  onTestFinished(async () => {
    await app.dispose()
    logs.mockRestore()
  })

  const logged = (): Record<string, unknown>[] =>
    logs.mock.calls.flatMap((call) => {
      try {
        return [JSON.parse(String(call[0]))]
      } catch {
        return []
      }
    })

  return {
    fetch: (path: string, init?: RequestInit) => app.handler(new Request(`http://api.test${path}`, init)),
    logged
  }
}
