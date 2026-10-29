import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse
} from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { SqlClient } from "@effect/sql"
import { Duration, Effect, Layer } from "effect"
import { AppConfig } from "./AppConfig.js"
import { notFound } from "./plat5/Errors.js"
import { SqlLive } from "./Sql.js"
import { MetricsScrape } from "./Telemetry.js"

const JSON_TYPE = "application/json; charset=utf-8"

const health = (status: number, word: "healthy" | "unhealthy") =>
  HttpServerResponse.unsafeJson({ status: word }, { status, contentType: JSON_TYPE })

/** Ready when the database answers, within 2 seconds. */
const ready = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql`SELECT 1`.pipe(
    Effect.timeoutFail({ duration: Duration.seconds(2), onTimeout: () => "timeout" }),
    Effect.as(health(200, "healthy")),
    Effect.orElseSucceed(() => health(503, "unhealthy"))
  )
})

const metrics = Effect.gen(function*() {
  const scrape = yield* MetricsScrape
  const body = yield* scrape.collect
  return HttpServerResponse.text(body, {
    contentType: "text/plain; version=0.0.4; charset=utf-8"
  })
})

/** Anything else, any method, is the 404 envelope. */
const unknownRoute = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const requestId = request.headers["x-request-id"] || null
  return HttpServerResponse.unsafeJson(notFound("resource", null, requestId), {
    status: 404,
    contentType: JSON_TYPE
  })
})

export const InternalApp = HttpRouter.empty.pipe(
  HttpRouter.get("/health/live", Effect.succeed(health(200, "healthy"))),
  HttpRouter.get("/health/ready", ready),
  HttpRouter.get("/metrics", metrics),
  Effect.catchTag("RouteNotFound", () => unknownRoute)
)

export const InternalHttpLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const config = yield* AppConfig

    return HttpServer.serve(InternalApp).pipe(
      HttpMiddleware.withTracerDisabledForUrls([
        "/health/live",
        "/health/ready",
        "/metrics"
      ]),
      HttpServer.withLogAddress,
      Layer.provide(BunHttpServer.layer({ port: config.internalPort }))
    )
  })
).pipe(Layer.provide(SqlLive), Layer.provide(AppConfig.Live))
