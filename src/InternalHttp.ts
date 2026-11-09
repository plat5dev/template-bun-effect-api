import { BunHttpServer } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { AppConfig } from "./AppConfig.js"
import { errorResponse, NotFound } from "./plat5/Errors.js"
import { SqlLive } from "./Sql.js"
import { scrape } from "./Telemetry.js"

const health = (status: number, word: "healthy" | "unhealthy") =>
  HttpServerResponse.jsonUnsafe({ status: word }, { status })

/** Ready when the database answers, within 2 seconds. */
const ready = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql`SELECT 1`.pipe(
    Effect.timeout(Duration.seconds(2)),
    Effect.as(health(200, "healthy")),
    Effect.orElseSucceed(() => health(503, "unhealthy"))
  )
})

const metrics = Effect.map(
  scrape,
  (body) => HttpServerResponse.text(body, { contentType: "text/plain; version=0.0.4; charset=utf-8" })
)

/** Anything else, any method, is the 404 envelope. */
const unknownRoute = errorResponse(new NotFound({ resource: "resource", id: null }), 404)

/** The internal port's routes: health, readiness and the Prometheus scrape. */
export const InternalRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/health/live", health(200, "healthy")),
  HttpRouter.add("GET", "/health/ready", ready),
  HttpRouter.add("GET", "/metrics", metrics),
  HttpRouter.add("*", "*", unknownRoute)
)

export const InternalHttpLive = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AppConfig
    return HttpRouter.serve(InternalRoutes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provide(HttpMiddleware.layerTracerDisabledForUrls(["/health/live", "/health/ready", "/metrics"])),
      Layer.provide(BunHttpServer.layer({ port: config.internalPort }))
    )
  })
).pipe(Layer.provide(SqlLive), Layer.provide(AppConfig.layer))
