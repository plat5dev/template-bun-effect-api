import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware
} from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Api } from "./Api.js"
import { AppConfig } from "./AppConfig.js"
import { httpObservability } from "./plat5/HttpObservability.js"
import { HttpProfilesLive } from "./Profiles/Http.js"
import { HttpTasksLive } from "./Tasks/Http.js"

const ApiLive = HttpApiBuilder.api(Api).pipe(
  Layer.provide([HttpProfilesLive, HttpTasksLive])
)

/**
 * The public API, on whatever HTTP server it's given. Its server span is
 * httpObservability's, so the platform's own (named `http.server {method}`, parented on b3
 * as well as traceparent) is off.
 */
export const PublicApiLive = HttpApiBuilder.serve(httpObservability(Api)).pipe(
  HttpMiddleware.withTracerDisabledWhen(() => true),
  Layer.provide(HttpApiSwagger.layer({ path: "/docs" })),
  Layer.provide(HttpApiBuilder.middlewareOpenApi()),
  // No CORS: the gateway owns it (plat5 docs/guides/write-a-service.md)
  Layer.provide(ApiLive)
)

export const PublicHttpLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const config = yield* AppConfig

    return PublicApiLive.pipe(
      Layer.provide(BunHttpServer.layer({ port: config.port }))
    )
  })
).pipe(Layer.provide(AppConfig.Live))
