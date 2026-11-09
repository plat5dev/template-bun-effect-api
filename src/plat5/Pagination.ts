/**
 * List parameters, the way every Plat5 list takes them (plat5 docs/reference/lists.md).
 *
 * `limit` defaults to 50; over 100 is clamped; under 1 or not a whole number is a 422.
 * `starting_after` is the id of the last item on the previous page: a lowercase ULID, else a
 * 422. Lists run in id order (ids are ULIDs, so oldest first) and answer with the collection
 * and `has_more`.
 */
import { Schema } from "effect"
import { Ulid } from "./Ids.js"

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100

/** URL params for list routes. */
export const ListParams = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)).annotate({
      description: `Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT} (more is ${MAX_LIMIT}).`
    })
  ),
  starting_after: Schema.optionalKey(Ulid.annotate({ description: "The id of the last item on the previous page." }))
})
export type ListParams = typeof ListParams.Type

/** One request's limit and cursor. An empty `startingAfter` is the first page. */
export type Page = { readonly limit: number; readonly startingAfter: string }

/** The page `params` ask for, the limit clamped. A cursor not in the list isn't an error: the walk continues after it. */
export const pageOf = (params: ListParams): Page => ({
  limit: Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
  startingAfter: params.starting_after ?? ""
})

/** Cuts rows fetched with `limit + 1` down to the page, and says whether another exists. */
export const trim = <T>(
  rows: ReadonlyArray<T>,
  page: Page
): { readonly items: ReadonlyArray<T>; readonly hasMore: boolean } =>
  rows.length > page.limit
    ? { items: rows.slice(0, page.limit), hasMore: true }
    : { items: rows, hasMore: false }
