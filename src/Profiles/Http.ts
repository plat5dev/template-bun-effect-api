import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../Api.js"
import { Plat5Request } from "../plat5/Request.js"
import { Profiles } from "./Service.js"

export const HttpProfilesLive = HttpApiBuilder.group(
  Api,
  "profiles",
  Effect.fn(function*(handlers) {
    const profiles = yield* Profiles

    return handlers.handleAll({
      get: ({ params }) => profiles.getOrCreate(params.user_id),
      upsert: ({ params, payload }) => profiles.upsert(params.user_id, payload)
    })
  })
).pipe(Layer.provide([Profiles.layer, Plat5Request.layer]))
