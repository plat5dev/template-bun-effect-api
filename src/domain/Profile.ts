import { Model } from "@effect/sql"
import { Schema } from "effect"

export class Profile extends Model.Class<Profile>("Profile")({
  user_id: Model.GeneratedByApp(Schema.String),
  display_name: Schema.NonEmptyTrimmedString,
  bio: Schema.String.pipe(Schema.maxLength(2000)),
  created_at: Model.GeneratedByApp(Schema.String),
  updated_at: Model.GeneratedByApp(Schema.String)
}) {}
