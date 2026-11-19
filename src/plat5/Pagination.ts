/**
 * Plat5 cursor pagination and ULID identifier primitives.
 */
import { Schema } from "effect"

/** Lowercase 26-character ULID (first character 0-7). */
export const Ulid = Schema.String.check(
  Schema.isPattern(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/u, { message: "Expected a lowercase ULID." })
)

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100

export const ListParams = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt({ message: "Limit must be a whole number." }),
      Schema.isGreaterThanOrEqualTo(1, { message: "Limit must be at least 1." })
    ).annotate({ description: `Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT} (clamped).` })
  ),
  starting_after: Schema.optionalKey(
    Ulid.annotate({ description: "The id of the last item on the previous page." })
  )
})
export type ListParams = typeof ListParams.Type

export type Page = { readonly limit: number; readonly startingAfter: string }

export const pageOf = (params: ListParams): Page => ({
  limit: Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
  startingAfter: params.starting_after ?? ""
})

export const trim = <T>(
  rows: ReadonlyArray<T>,
  page: Page
): { readonly items: ReadonlyArray<T>; readonly hasMore: boolean } =>
  rows.length > page.limit
    ? { items: rows.slice(0, page.limit), hasMore: true }
    : { items: rows, hasMore: false }
