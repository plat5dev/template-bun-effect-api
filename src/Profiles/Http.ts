import { HttpApiBuilder } from "@effect/platform"
import { Effect, Layer } from "effect"
import { Api } from "../Api.js"
import { CurrentUser, RequireUserLive } from "../plat5/Identity.js"
import { Profiles } from "./Service.js"

export const HttpProfilesLive = HttpApiBuilder.group(Api, "profiles", (handlers) =>
  Effect.gen(function*() {
    const profiles = yield* Profiles

    return handlers
      .handle("getMe", () =>
        CurrentUser.pipe(
          Effect.flatMap((user) => profiles.getOrCreateMe(user.userId))
        ))
      .handle("upsertMe", ({ payload }) =>
        CurrentUser.pipe(
          Effect.flatMap((user) => profiles.upsertMe(user.userId, payload))
        ))
      .handle("getById", ({ path }) => profiles.getByUserId(path.user_id))
  })
).pipe(Layer.provide([Profiles.Default, RequireUserLive]))
