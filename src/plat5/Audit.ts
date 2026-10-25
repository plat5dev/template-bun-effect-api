/**
 * What a write changed, for Plat5's audit log (plat5 docs/concepts/audit.md#what-a-service-adds).
 *
 * The gateway records every audited request before it reaches this service. A write adds
 * what it changed on `X-Plat5-Audit-Details`, and a create names the id it made on
 * `X-Plat5-Audit-Created`. The gateway stores both with the event and strips them before
 * the response reaches the client.
 *
 * Changes are `{ from, to }` for the fields that changed. A create names what it made.
 * A delete sends nothing: the route and its path say what happened. Never a secret.
 *
 * The headers are added to the current request's response with a pre-response handler, so
 * a service can call these where it has the old and new values in hand.
 */
import { HttpApp, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"

export const DETAILS_HEADER = "X-Plat5-Audit-Details"
export const CREATED_HEADER = "X-Plat5-Audit-Created"
/** The gateway's cap. Over it, the gateway would drop the details. */
export const MAX_BYTES = 4096

/** One write's change. */
export type Details = Record<string, unknown>

/** Records `field` when `from` and `to` differ. */
export const changed = (
  details: Details,
  field: string,
  from: unknown,
  to: unknown
): void => {
  if (from !== to) details[field] = { from, to }
}

/**
 * `details` as one JSON object of visible ASCII, or null over the cap. Non-ASCII is
 * escaped as \u, which is still the same JSON.
 */
export const encode = (details: Details): string | null => {
  const json = JSON.stringify(details).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  )
  return json.length > MAX_BYTES ? null : json
}

const setHeader = (name: string, value: string) =>
  HttpApp.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, name, value))
  )

/**
 * Puts `details` on the response. Empty sets nothing, so a write that changed nothing
 * sends no header. Over the cap sets nothing and notes it on the span: the event still
 * records the request, just not the change.
 */
export const setDetails = (details: Details): Effect.Effect<void> => {
  if (Object.keys(details).length === 0) return Effect.void
  const value = encode(details)
  if (value === null) {
    return Effect.annotateCurrentSpan("audit.details_not_sent", `over ${MAX_BYTES} bytes`)
  }
  return setHeader(DETAILS_HEADER, value)
}

/** Names the id a create produced. The audit log can be searched by it. */
export const setCreated = (id: string): Effect.Effect<void> => setHeader(CREATED_HEADER, id)
