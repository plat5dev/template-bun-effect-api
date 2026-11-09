import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { Profile, ProfileUpdate } from "../domain/Profile.js"
import { Plat5Request } from "../plat5/Request.js"

// No name here: the person's name is identity's (GET /user), shown in every org.

/** A profile as the API answers with it: the `Profile` component of the OpenAPI document. */
const ProfileJson = Profile.json.annotate({ identifier: "Profile" })

const UserPath = { user_id: Schema.String }

export class ProfilesApi extends HttpApiGroup.make("profiles")
  .add(
    HttpApiEndpoint.get("get", "/", {
      params: UserPath,
      success: ProfileJson,
    }),
    HttpApiEndpoint.put("upsert", "/", {
      params: UserPath,
      payload: ProfileUpdate,
      success: ProfileJson,
    })
  )
  // Every request read, and every defect answered, the Plat5 way (src/plat5/Request.ts).
  .middleware(Plat5Request)
  .prefix("/users/:user_id/profile")
  .annotateMerge(OpenApi.annotations({ title: "Profiles", description: "The person's own profile" }))
{}
