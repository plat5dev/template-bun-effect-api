import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/http"
import { HttpApiBuilder, HttpApiSwagger } from "effect/http-api"
import { Api } from "./Api.js"
import { AppConfig } from "./AppConfig.js"
import { errorResponse, NotFound } from "./plat5/Errors.js"
import { httpObservability } from "./plat5/HttpObservability.js"
import { HttpProfilesLive } from "./Profiles/Http.js"
import { HttpTasksLive } from "./Tasks/Http.js"

const unknownRoute = errorResponse(new NotFound({ resource: "resource", id: null }), 404)

/**
 * The API's routes, its OpenAPI document at `/openapi.json`, and Swagger UI at `/docs`.
 * Anything else (a known path in another method, say) is the 404 envelope. HEAD isn't caught,
 * so the router answers it as the path's GET, or an empty 404.
 */
export const PublicRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide([HttpProfilesLive, HttpTasksLive])
  ),
  HttpApiSwagger.layer(Api, { path: "/docs" }),
  HttpRouter.addAll(
    (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const).map((method) =>
      HttpRouter.route(method, "*", unknownRoute)
    )
  )
)

/**
 * The public API, on whatever HTTP server it's given. Its server span and access log are
 * httpObservability's (named by route, with plat5's status rules), so the platform's own
 * span and logger are off.
 * No CORS: the gateway owns it (plat5 docs/guides/write-a-service.md).
 */
export const PublicApiLive = HttpRouter.serve(PublicRoutes, {
  middleware: httpObservability(Api),
  disableLogger: true,
  disableListenLog: true
}).pipe(Layer.provide(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true)))

export const PublicHttpLive = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AppConfig
    return PublicApiLive.pipe(Layer.provide(BunHttpServer.layer({ port: config.port })))
  })
).pipe(Layer.provide(AppConfig.layer))
