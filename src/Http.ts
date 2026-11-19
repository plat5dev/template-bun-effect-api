/**
 * Public HTTP API definition, route handlers, OpenAPI/Swagger, and Bun server layer.
 */
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiSwagger, OpenApi } from "effect/http-api"
import type { SqlError } from "effect/sql/SqlError"
import { AppConfig } from "./Config.js"
import { errorResponse, NotFound, parseOptions, Plat5Query, Plat5Request } from "./plat5/Errors.js"
import { catchDefectsLayer, httpObservability } from "./plat5/HttpObservability.js"
import { Profiles, ProfilesApi } from "./Profiles.js"
import { MEMBER_HEADER, Tasks, TasksApi } from "./Tasks.js"

export class Api extends HttpApi.make("api")
  .add(ProfilesApi)
  .add(TasksApi)
  .annotate(HttpApi.PayloadParseOptions, parseOptions.payload)
  .annotate(HttpApi.QueryParseOptions, parseOptions.query)
  .annotateMerge(OpenApi.annotations({
    title: "Plat5 API",
    description: "Reference Bun + Effect business service for Plat5"
  }))
{}

const orInternalError = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, Exclude<E, SqlError>, R> =>
  effect.pipe(
    Effect.catch((err) =>
      typeof err === "object" && err !== null && "_tag" in err && err._tag === "SqlError"
        ? Effect.die(err)
        : Effect.fail(err as Exclude<E, SqlError>)
    )
  )

const HttpProfilesLive = HttpApiBuilder.group(
  Api,
  "profiles",
  Effect.fn(function*(handlers) {
    const profiles = yield* Profiles
    return handlers.handleAll({
      get: ({ params }) => orInternalError(profiles.getOrCreate(params.user_id)),
      upsert: ({ params, payload }) => orInternalError(profiles.upsert(params.user_id, payload))
    })
  })
)

const HttpTasksLive = HttpApiBuilder.group(
  Api,
  "tasks",
  Effect.fn(function*(handlers) {
    const tasks = yield* Tasks
    return handlers.handleAll({
      list: ({ params, query }) =>
        orInternalError(tasks.list(params.project_id, query)).pipe(
          Effect.map(({ hasMore, items }) => ({ tasks: items, has_more: hasMore }))
        ),
      create: ({ headers, params, payload }) =>
        orInternalError(tasks.create(params.project_id, headers[MEMBER_HEADER], payload)),
      get: ({ params }) => orInternalError(tasks.getInProject(params.project_id, params.task_id)),
      update: ({ params, payload }) => orInternalError(tasks.update(params.project_id, params.task_id, payload)),
      remove: ({ params }) => orInternalError(tasks.remove(params.project_id, params.task_id))
    })
  })
)

const unknownRoute = errorResponse(new NotFound({ resource: "resource", id: null }), 404)

export const PublicRoutes = Layer.mergeAll(
  catchDefectsLayer,
  HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(
      Layer.mergeAll(HttpProfilesLive, HttpTasksLive).pipe(
        Layer.provide([Plat5Request.layer, Plat5Query.layer])
      )
    )
  ),
  HttpApiSwagger.layer(Api, { path: "/docs" }),
  HttpRouter.addAll(
    (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const).map((method) =>
      HttpRouter.route(method, "*", unknownRoute)
    )
  )
)

export const publicMiddleware = httpObservability(Api, [
  { method: "GET", template: "/docs" },
  { method: "GET", template: "/openapi.json" }
])

export const PublicApiLive = HttpRouter.serve(PublicRoutes, {
  middleware: publicMiddleware,
  disableLogger: true,
  disableListenLog: true
}).pipe(Layer.provide(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true)))

export const PublicHttpLive = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AppConfig
    return PublicApiLive.pipe(Layer.provide(BunHttpServer.layer({ port: config.port })))
  })
)
