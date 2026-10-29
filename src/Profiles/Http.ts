import { HttpApiBuilder } from "@effect/platform"
import { Effect, Layer } from "effect"
import { Api } from "../Api.js"
import { readBody } from "../plat5/Body.js"
import { Profiles } from "./Service.js"

export const HttpProfilesLive = HttpApiBuilder.group(Api, "profiles", (handlers) =>
  Effect.gen(function*() {
    const profiles = yield* Profiles

    return handlers
      .handle("get", ({ path }) => profiles.getOrCreate(path.user_id))
      // Raw: it reads its own body (src/plat5/Body.ts).
      .handleRaw("upsert", ({ path }) =>
        readBody(["bio"]).pipe(Effect.flatMap((fields) => profiles.upsert(path.user_id, fields))))
  })
).pipe(Layer.provide(Profiles.Default))
