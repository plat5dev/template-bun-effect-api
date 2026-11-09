import { Effect, Option } from "effect"
import { HttpServerRequest } from "effect/http"

/** The current request's `X-Request-ID`, or null outside a request or without one. */
export const currentRequestId: Effect.Effect<string | null> = Effect.map(
  Effect.serviceOption(HttpServerRequest.HttpServerRequest),
  Option.match({ onNone: () => null, onSome: (request) => request.headers["x-request-id"] || null })
)
