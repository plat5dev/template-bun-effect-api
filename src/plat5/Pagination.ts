/**
 * List parameters, the way every Plat5 list takes them (plat5 docs/reference/lists.md).
 *
 * `limit` defaults to 50; over 100 is clamped. `starting_after` is the id of the last item
 * on the previous page. Lists run in id order (ids are ULIDs, so oldest first) and answer
 * with the collection and `has_more`.
 */
import { Effect, Schema } from "effect"
import { isValid } from "ulid"
import { fieldError, type ValidationFailed } from "./Errors.js"

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100

/** URL params for list routes. Strings here, so a bad value is our 422, not a decode error. */
export const ListParams = Schema.Struct({
  limit: Schema.optional(Schema.String),
  starting_after: Schema.optional(Schema.String)
})
export type ListParams = typeof ListParams.Type

/** Plat5 ids, and this API's, are ULIDs in lowercase. */
const isLowercaseUlid = (id: string): boolean => isValid(id) && id === id.toLowerCase()

/** One request's limit and cursor. An empty `startingAfter` is the first page. */
export type Page = { readonly limit: number; readonly startingAfter: string }

/**
 * Reads `limit` and `starting_after`. A limit under 1 or not a whole number, or a cursor
 * that isn't a lowercase ULID, is a 422. A well-formed cursor that isn't in the list is not
 * an error: the walk continues after it in id order.
 */
export const parsePage = (params: ListParams): Effect.Effect<Page, ValidationFailed> => {
  let limit = DEFAULT_LIMIT
  const rawLimit = params.limit?.trim()
  if (rawLimit) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) {
      return Effect.fail(fieldError("limit"))
    }
    limit = Math.min(Number(rawLimit), MAX_LIMIT)
  }
  const startingAfter = params.starting_after?.trim() ?? ""
  if (startingAfter && !isLowercaseUlid(startingAfter)) {
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
