import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerResponse
} from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { AppConfig } from "./AppConfig.js"
import { MetricsScrape } from "./Telemetry.js"

const ok = HttpServerResponse.json({ status: "healthy" })

const metrics = Effect.gen(function*() {
  const scrape = yield* MetricsScrape
  const body = yield* scrape.collect
  return HttpServerResponse.text(body, {
    contentType: "text/plain; version=0.0.4; charset=utf-8"
  })
})

const InternalApp = HttpRouter.empty.pipe(
  HttpRouter.get("/health/live", ok),
  HttpRouter.get("/health/ready", ok),
  HttpRouter.get("/metrics", metrics)
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
).pipe(Layer.provide(AppConfig.Live))
