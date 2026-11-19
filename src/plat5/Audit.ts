/**
 * Plat5 audit response headers (`X-Plat5-Audit-Details`, `X-Plat5-Audit-Created`).
 * The gateway stores them with the audit event and strips them before replying to clients.
 */
import { Clock, Effect, Option } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"

export const DETAILS_HEADER = "X-Plat5-Audit-Details"
export const CREATED_HEADER = "X-Plat5-Audit-Created"
export const MAX_BYTES = 4096

export type Details = Record<string, unknown>

export const changed = (details: Details, field: string, from: unknown, to: unknown): void => {
  if (from !== to) details[field] = { from, to }
}

/**
 * Encodes `details` as a visible-ASCII JSON object, escaping control and non-ASCII characters
 * as `\uXXXX`. Returns null if the encoded header exceeds `MAX_BYTES`.
 */
export const encode = (details: Details): string | null => {
  const sorted: Details = {}
  for (const key of Object.keys(details).sort()) sorted[key] = details[key]
  const json = JSON.stringify(sorted).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  )
  return json.length > MAX_BYTES ? null : json
}

const setHeader = (name: string, value: string): Effect.Effect<void> =>
  Effect.serviceOption(HttpServerRequest.HttpServerRequest).pipe(
    Effect.flatMap(Option.match({
      onNone: () => Effect.void,
      onSome: (request) =>
        HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, name, value))
        ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
    }))
  )

export const setDetails = (details: Details): Effect.Effect<void> => {
  if (Object.keys(details).length === 0) return Effect.void
  const value = encode(details)
  if (value === null) {
    return Effect.gen(function*() {
      const span = yield* Effect.currentSpan
      span.event("audit details not sent", yield* Clock.currentTimeNanos, {
        reason: `audit details are over ${MAX_BYTES} bytes`
      })
    }).pipe(Effect.ignore)
  }
  return setHeader(DETAILS_HEADER, value)
}

export const setCreated = (id: string): Effect.Effect<void> => setHeader(CREATED_HEADER, id)
