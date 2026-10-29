import { Model } from "@effect/sql"
import { Schema } from "effect"

export class Profile extends Model.Class<Profile>("Profile")({
  user_id: Model.GeneratedByApp(Schema.String),
  // At most 2000 characters, checked by the service: a schema's maxLength counts UTF-16 units.
  bio: Schema.String,
  created_at: Model.GeneratedByApp(Schema.String),
  updated_at: Model.GeneratedByApp(Schema.String)
}) {}
