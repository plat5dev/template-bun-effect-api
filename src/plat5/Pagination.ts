/**
 * List parameters, the way every Plat5 list takes them (plat5 docs/reference/lists.md).
 *
 * `limit` defaults to 50; over 100 is clamped. `starting_after` is the id of the last item
 * on the previous page. Lists run in id order (ids are ULIDs, so oldest first) and answer
 * with the collection and `has_more`.
 */
import { Effect, Schema } from "effect"
import { isLowercaseUlid, trimSpace } from "./Body.js"
import { fieldError, type ValidationFailed } from "./Errors.js"

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100

// Strings here, so a bad value is our 422, not a decode error; a repeated one is a list.
const Param = Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String)))

/** URL params for list routes. */
export const ListParams = Schema.Struct({
  limit: Param,
  starting_after: Param
})
export type ListParams = typeof ListParams.Type

/** One request's limit and cursor. An empty `startingAfter` is the first page. */
export type Page = { readonly limit: number; readonly startingAfter: string }

/** A parameter's first value, white space trimmed, or "" without one. */
const first = (value: string | ReadonlyArray<string> | undefined): string =>
  trimSpace((typeof value === "string" ? value : value?.[0]) ?? "")

const INT64_MAX = 2n ** 63n - 1n

/**
 * A whole number in base 10 with an optional sign, as Go's strconv.Atoi reads it, or null
 * when it isn't one or doesn't fit in 64 bits.
 */
const atoi = (s: string): number | null => {
  if (!/^[+-]?\d+$/.test(s)) return null
  const n = BigInt(s)
  return n > INT64_MAX || n < -INT64_MAX - 1n ? null : Number(n)
}

/**
 * Reads `limit` and `starting_after` (the first of each). A limit under 1 or not a whole
 * number, or a cursor that isn't a lowercase ULID, is a 422; the limit is checked first. A
 * well-formed cursor that isn't in the list is not an error: the walk continues after it
 * in id order.
 */
export const parsePage = (params: ListParams): Effect.Effect<Page, ValidationFailed> => {
  let limit = DEFAULT_LIMIT
  const rawLimit = first(params.limit)
  if (rawLimit !== "") {
    const n = atoi(rawLimit)
    if (n === null || n < 1) return Effect.fail(fieldError("limit"))
    limit = Math.min(n, MAX_LIMIT)
  }
  const startingAfter = first(params.starting_after)
  if (startingAfter !== "" && !isLowercaseUlid(startingAfter)) {
    return Effect.fail(fieldError("starting_after"))
  }
  return Effect.succeed({ limit, startingAfter })
}

/** Cuts rows fetched with `limit + 1` down to the page, and says whether another exists. */
export const trim = <T>(
  rows: ReadonlyArray<T>,
  page: Page
): { readonly items: ReadonlyArray<T>; readonly hasMore: boolean } =>
  rows.length > page.limit
    ? { items: rows.slice(0, page.limit), hasMore: true }
    : { items: rows, hasMore: false }
