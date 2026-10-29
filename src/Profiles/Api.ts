import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform"
import { Schema } from "effect"
import { Profile } from "../domain/Profile.js"
import { InternalError, ValidationFailed } from "../plat5/Errors.js"

// No name here: the person's name is identity's (GET /user), shown in every org. For the
// OpenAPI document: the handler reads the body (src/plat5/Body.ts).
const ProfileUpdate = Schema.Struct({
  bio: Schema.String.annotations({ description: "At most 2000 characters, kept as sent." })
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
  .annotate(OpenApi.Description, "The person's own profile")
{}
