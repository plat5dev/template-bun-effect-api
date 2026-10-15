import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform"
import { Schema } from "effect"
import { Profile } from "../domain/Profile.js"
import { InternalError, ValidationFailed } from "../plat5/Errors.js"

// No name here: the person's name is identity's (GET /user), shown in every org.
const ProfileUpdate = Schema.Struct({
  bio: Schema.String.pipe(Schema.maxLength(2000))
})

const UserPath = Schema.Struct({
  user_id: Schema.String
})

export class ProfilesApi extends HttpApiGroup.make("profiles")
  .add(
    HttpApiEndpoint.get("get", "/")
      .setPath(UserPath)
      .addSuccess(Profile.json)
      .addError(InternalError)
  )
  .add(
    HttpApiEndpoint.put("upsert", "/")
      .setPath(UserPath)
      .setPayload(ProfileUpdate)
      .addSuccess(Profile.json)
      .addError(InternalError)
      .addError(ValidationFailed)
  )
  .prefix("/users/:user_id/profile")
  .annotate(OpenApi.Title, "Profiles")
  .annotate(OpenApi.Description, "The caller's profile")
{}
