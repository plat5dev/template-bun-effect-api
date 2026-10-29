/**
 * Reads a request's JSON body: a body sent as JSON, or a 422 at `body`.
 *
 * A body counts as JSON only with Content-Type `application/json` (any parameters, such as
 * charset) or an `application/…+json` type. Without a Content-Type, or with any other, the
 * body is a 422 at `body` whatever it holds, empty included: a client that forgot the
 * header never gets a write that silently changed nothing. A body that isn't a JSON object,
 * or a field of the wrong JSON type, is the same 422: bind failures use the fallback
 * sentence (plat5 docs/reference/error-copy.md).
 *
 * Routes that read a body use `handleRaw`, so Effect never decodes it for them; a route
 * that reads none, such as DELETE, takes any body.
 */
import { HttpServerRequest } from "@effect/platform"
import { Effect } from "effect"
import { fieldError, type ValidationFailed } from "./Errors.js"

// Go's unicode.IsSpace, which isn't quite JavaScript's trim (U+0085 is space, U+FEFF isn't).
const SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
const EDGE_SPACE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "g")

/** `s` without leading and trailing Unicode white space, as Go's strings.TrimSpace. */
export const trimSpace = (s: string): string => s.replace(EDGE_SPACE, "")

/** `s`'s length in characters (Unicode code points), not UTF-16 units. */
export const charLength = (s: string): number => {
  let n = 0
  for (const _ of s) n++
  return n
}

/** A Plat5 id, and this API's: a ULID (its first character 0-7), in lowercase. */
export const isLowercaseUlid = (id: string): boolean => /^[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(id)

/** Whether `contentType` names JSON: application/json or application/…+json, any parameters. */
export const isJson = (contentType: string | undefined): boolean => {
  if (contentType === undefined) return false
  const type = trimSpace(contentType.split(";")[0]!).toLowerCase()
  return type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"))
}

/** A body's fields: each one's JSON value, or undefined when the body hasn't it. */
export type Fields = Record<string, unknown>

/**
 * The request's body as `names`' values. A body not sent as JSON, an empty body, or one
 * that isn't a JSON object (malformed, trailing data, an array) is a 422 at `body`; a JSON
 * null is an empty object. Keys match their names ignoring case, as Go's decoder matches
 * them, the last one winning; others are ignored. Unpaired surrogates in a string become
 * U+FFFD, as Go decodes them.
 */
export const readBody = (
  names: ReadonlyArray<string>
): Effect.Effect<Fields, ValidationFailed, HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!isJson(request.headers["content-type"])) return yield* Effect.fail(fieldError("body"))
    const text = yield* Effect.orDie(request.text)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return yield* Effect.fail(fieldError("body"))
    }
    if (parsed === null) return {}
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return yield* Effect.fail(fieldError("body"))
    }
    const fields: Fields = {}
    for (const [key, value] of Object.entries(parsed)) {
      const folded = key.toLowerCase().replace(/ſ/g, "s")
      const name = names.includes(key) ? key : names.find((n) => n === folded)
      if (name !== undefined) fields[name] = typeof value === "string" ? value.toWellFormed() : value
    }
    return fields
  })

/**
 * A field that must be a string when it's set: the string, or undefined when absent or
 * null. Any other JSON type is a 422 at `body`, as Go's decoder answers it. Check every
 * field's type before any field's value, as Go does.
 */
export const optionalString = (
  fields: Fields,
  name: string
): Effect.Effect<string | undefined, ValidationFailed> => {
  const value = fields[name]
  if (value === undefined || value === null) return Effect.succeed(undefined)
  if (typeof value !== "string") return Effect.fail(fieldError("body"))
  return Effect.succeed(value)
}
