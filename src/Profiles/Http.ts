import { HttpApiBuilder } from "@effect/platform"
import { Effect, Layer } from "effect"
import { Api } from "../Api.js"
import { Profiles } from "./Service.js"

export const HttpProfilesLive = HttpApiBuilder.group(Api, "profiles", (handlers) =>
  Effect.gen(function*() {
    const profiles = yield* Profiles

    return handlers
      .handle("get", ({ path }) => profiles.getOrCreate(path.user_id))
      .handle("upsert", ({ path, payload }) => profiles.upsert(path.user_id, payload))
  })
).pipe(Layer.provide(Profiles.Default))
