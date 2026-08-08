import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform"
import { Schema } from "effect"
import { Profile } from "../domain/Profile.js"
import { InternalError, NotFound, ValidationFailed } from "../plat5/Errors.js"
import { RequireUser } from "../plat5/Identity.js"

const ProfileUpdate = Schema.Struct({
  display_name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  bio: Schema.optional(Schema.String.pipe(Schema.maxLength(2000)))
})

export class ProfilesApi extends HttpApiGroup.make("profiles")
  .add(
    HttpApiEndpoint.get("getMe", "/me")
      .addSuccess(Profile.json)
      .addError(InternalError)
  )
  .add(
    HttpApiEndpoint.put("upsertMe", "/me")
      .setPayload(ProfileUpdate)
      .addSuccess(Profile.json)
      .addError(InternalError)
      .addError(ValidationFailed)
  )
  .add(
    HttpApiEndpoint.get("getById", "/:user_id")
      .setPath(Schema.Struct({ user_id: Schema.String }))
      .addSuccess(Profile.json)
      .addError(NotFound)
      .addError(InternalError)
  )
  .middleware(RequireUser)
  .prefix("/api/profiles")
  .annotate(OpenApi.Title, "Profiles")
  .annotate(OpenApi.Description, "User-scoped profiles (gateway X-User-Id)")
{}
