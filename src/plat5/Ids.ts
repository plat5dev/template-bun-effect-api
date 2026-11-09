import { Schema } from "effect"

/** A Plat5 id, and this API's: a ULID (its first character 0-7), in lowercase. */
export const Ulid = Schema.String.check(Schema.isPattern(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/u))
