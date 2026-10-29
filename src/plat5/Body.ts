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
 * Keys match exactly: `{"Title": …}` is an unknown field, not title, and a body with an
 * unknown field is a 422 naming each one, before any value is checked.
 *
 * Routes that read a body use `handleRaw`, so Effect never decodes it for them; a route
 * that reads none, such as DELETE, takes any body.
 */
import { HttpServerRequest } from "@effect/platform"
import { Effect } from "effect"
import { fieldError, validationFailed, type ValidationFailed } from "./Errors.js"

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
 * What a body's keys may be. `anything` takes any value; `object` takes exactly its keys,
 * each value checked as its shape; `arrayOf` checks each item; `recordOf` takes any keys,
 * each value checked as its shape.
 */
export type Shape =
  | { readonly kind: "any" }
  | { readonly kind: "object"; readonly fields: ReadonlyMap<string, Shape> }
  | { readonly kind: "array"; readonly items: Shape }
  | { readonly kind: "record"; readonly values: Shape }

export const anything: Shape = { kind: "any" }
export const object = (fields: Readonly<Record<string, Shape>>): Shape => ({
  kind: "object",
  fields: new Map(Object.entries(fields))
})
export const arrayOf = (items: Shape): Shape => ({ kind: "array", items })
export const recordOf = (values: Shape): Shape => ({ kind: "record", values })

/** Walks valid JSON text in order, which JSON.parse's objects don't keep (integer keys first). */
class Scanner {
  private i = 0
  constructor(private readonly s: string) {}

  private space(): void {
    while (this.i < this.s.length && " \t\n\r".includes(this.s[this.i]!)) this.i++
  }

  private peek(): string {
    this.space()
    return this.s[this.i]!
  }

  private string(): string {
    const start = this.i++
    while (this.s[this.i] !== '"') this.i += this.s[this.i] === "\\" ? 2 : 1
    this.i++
    return JSON.parse(this.s.slice(start, this.i)) as string
  }

  /** Reads one value, adding the path of each key `shape` has no field for to `out`. */
  value(shape: Shape, path: string, out: string[]): void {
    const c = this.peek()
    if (c === "{") {
      this.i++
      if (this.peek() === "}") {
        this.i++
        return
      }
      for (;;) {
        this.peek()
        // A key as Go decodes it: an unpaired surrogate is U+FFFD.
        const key = this.string().toWellFormed()
        this.peek()
        this.i++ // :
        const p = path === "" ? key : `${path}.${key}`
        let child: Shape | undefined = anything
        if (shape.kind === "object") child = shape.fields.get(key)
        else if (shape.kind === "record") child = shape.values
        if (child === undefined) {
          out.push(p)
          child = anything
        }
        this.value(child, p, out)
        if (this.peek() === ",") this.i++
        else {
          this.i++ // }
          return
        }
      }
    }
    if (c === "[") {
      this.i++
      if (this.peek() === "]") {
        this.i++
        return
      }
      const items = shape.kind === "array" ? shape.items : anything
      for (let n = 0;; n++) {
        this.value(items, `${path}[${n}]`, out)
        if (this.peek() === ",") this.i++
        else {
          this.i++ // ]
          return
        }
      }
    }
    if (c === '"') {
      this.string()
      return
    }
    // A number, true, false or null.
    while (this.i < this.s.length && !",]} \t\n\r".includes(this.s[this.i]!)) this.i++
  }
}

/**
 * The paths of the keys in `json`, valid JSON text, that `shape` has no field for by exact
 * name, in the order they appear; a key repeated in the body is listed once, where it first
 * appears. A nested key's path is its parent's, a dot and the key (address.street); an array
 * item's is its parent's and its index (tags[0].name). A record takes any keys, and checks
 * its values (meta.key.field).
 */
export const unknownFields = (json: string, shape: Shape): Array<string> => {
  const all: Array<string> = []
  new Scanner(json).value(shape, "", all)
  return [...new Set(all)]
}

/** A 422 listing each key of `json`, valid JSON text, that `shape` has no field for. */
export const checkKeys = (json: string, shape: Shape): Effect.Effect<void, ValidationFailed> => {
  const unknown = unknownFields(json, shape)
  if (unknown.length === 0) return Effect.void
  return Effect.fail(validationFailed(unknown.map((path) => ({ path, message: `${path} isn't a field.` }))))
}

/**
 * The request's body as `names`' values. A body not sent as JSON, an empty body, or one
 * that isn't a JSON value (malformed, trailing data) is a 422 at `body`. Then a key that
 * isn't one of `names`, exactly, is a 422 listing every such key in the order they appear
 * (see unknownFields), each "<path> isn't a field.", the first one's the message: before
 * any value is checked. Then a body that isn't a JSON object (an array, a string…) is a
 * 422 at `body`. A JSON null is an empty object. A repeated key's last value wins. A string
 * has its unpaired surrogates replaced by U+FFFD, as Go decodes them.
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
    yield* checkKeys(text, object(Object.fromEntries(names.map((name) => [name, anything]))))
    if (parsed === null) return {}
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return yield* Effect.fail(fieldError("body"))
    }
    const fields: Fields = {}
    for (const [key, value] of Object.entries(parsed)) {
      fields[key] = typeof value === "string" ? value.toWellFormed() : value
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
