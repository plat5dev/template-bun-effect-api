import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpServer
} from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Api } from "./Api.js"
import { AppConfig } from "./AppConfig.js"
import { httpObservability } from "./plat5/HttpObservability.js"
import { HttpProfilesLive } from "./Profiles/Http.js"
import { HttpProjectsLive } from "./Projects/Http.js"
import { HttpTasksLive } from "./Tasks/Http.js"

const ApiLive = HttpApiBuilder.api(Api).pipe(
  Layer.provide([HttpProfilesLive, HttpProjectsLive, HttpTasksLive])
)

export const PublicHttpLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const config = yield* AppConfig

    return HttpApiBuilder.serve(httpObservability).pipe(
      Layer.provide(HttpApiSwagger.layer({ path: "/docs" })),
      Layer.provide(HttpApiBuilder.middlewareOpenApi()),
      // No CORS — gateway owns it (plat5 gateway-contract)
      Layer.provide(ApiLive),
      HttpServer.withLogAddress,
      Layer.provide(BunHttpServer.layer({ port: config.port }))
    )
  })
).pipe(Layer.provide(AppConfig.Live))
