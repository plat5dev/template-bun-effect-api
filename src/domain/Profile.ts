import { Schema } from "effect"
import { Model } from "effect/schema"

// The model sets created_at on insert and updated_at on every write.
export class Profile extends Model.Class<Profile>("Profile")({
  user_id: Model.GeneratedByApp(Schema.String),
  bio: Schema.String,
  created_at: Model.DateTimeInsert,
  updated_at: Model.DateTimeUpdate
}) {}

/** A profile's body: `bio`, at most 2000 characters, kept as sent (not trimmed; "" is a bio). */
export const ProfileUpdate = Schema.Struct({
  bio: Schema.String.check(Schema.isMaxCodePoints(2000, { message: "Bio is too long." })).pipe(
    Schema.annotate({ description: "At most 2000 characters, kept as sent." }),
    Schema.annotateKey({ messageMissingKey: "Bio is required." })
  )
})
export type ProfileUpdate = typeof ProfileUpdate.Type
