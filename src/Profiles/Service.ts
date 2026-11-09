import { Context, Effect, Layer, Option } from "effect"
import { Profile, type ProfileUpdate } from "../domain/Profile.js"
import * as Audit from "../plat5/Audit.js"
import { ProfilesRepo } from "./Repo.js"

export class Profiles extends Context.Service<Profiles>()("api/Profiles", {
  make: Effect.gen(function*() {
    const repo = yield* ProfilesRepo

    /** The person's profile: on their first call, an empty one. */
    const getOrCreate = Effect.fn("Profiles.getOrCreate")(function*(userId: string) {
      yield* Effect.annotateCurrentSpan("plat5.user_id", userId)
      const row = yield* Profile.insert.makeEffect({ user_id: userId, bio: "" }).pipe(Effect.orDie)
      return yield* repo.getOrInsert(row)
    })

    /** The body comes checked (src/domain/Profile.ts). */
    const upsert = Effect.fn("Profiles.upsert")(function*(userId: string, input: ProfileUpdate) {
      yield* Effect.annotateCurrentSpan("plat5.user_id", userId)
      const before = yield* repo.findByUserId(userId)
      const row = yield* Profile.insert.makeEffect({ user_id: userId, bio: input.bio }).pipe(Effect.orDie)
      const after = yield* repo.upsert(row)
      // A new profile: each field changed from nothing. The profile's id is the user's,
      // which the path already carries, so there is no created id.
      const changes: Audit.Details = {}
      Audit.changed(changes, "bio", Option.match(before, { onNone: () => null, onSome: (p) => p.bio }), after.bio)
      yield* Audit.setDetails(changes)
      return after
    })

    return { getOrCreate, upsert } as const
  })
}) {
  static readonly layerNoDeps = Layer.effect(this, this.make)
  static readonly layer = this.layerNoDeps.pipe(Layer.provide(ProfilesRepo.layer))
}
