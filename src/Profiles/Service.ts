import { Effect, Option } from "effect"
import { Profile } from "../domain/Profile.js"
import * as Audit from "../plat5/Audit.js"
import { ProfilesRepo } from "./Repo.js"

const now = () => new Date().toISOString()

export class Profiles extends Effect.Service<Profiles>()("Profiles", {
  effect: Effect.gen(function*() {
    const repo = yield* ProfilesRepo

    const getOrCreate = (userId: string) =>
      Effect.gen(function*() {
        const existing = yield* repo.findByUserId(userId)
        if (Option.isSome(existing)) {
          return existing.value
        }
        const ts = now()
        return yield* repo.insert(
          Profile.insert.make({
            user_id: userId,
            bio: "",
            created_at: ts,
            updated_at: ts
          })
        )
      }).pipe(
        Effect.withSpan("Profiles.getOrCreate", { attributes: { "plat5.user_id": userId } })
      )

    const upsert = (
      userId: string,
      payload: { bio: string }
    ) =>
      Effect.gen(function*() {
        const ts = now()
        const existing = yield* repo.findByUserId(userId)
        if (Option.isSome(existing)) {
          const before = existing.value
          const updated = yield* repo.update({
            ...before,
            bio: payload.bio,
            updated_at: ts
          })
          const changes: Audit.Details = {}
          Audit.changed(changes, "bio", before.bio, updated.bio)
          yield* Audit.setDetails(changes)
          return updated
        }
        const created = yield* repo.insert(
          Profile.insert.make({
            user_id: userId,
            bio: payload.bio,
            created_at: ts,
            updated_at: ts
          })
        )
        // A new profile: each field changed from nothing. The profile's id is the user's,
        // which the path already carries, so there is no created id.
        const changes: Audit.Details = { bio: { from: null, to: created.bio } }
        yield* Audit.setDetails(changes)
        return created
      }).pipe(
        Effect.withSpan("Profiles.upsert", { attributes: { "plat5.user_id": userId } })
      )

    return { getOrCreate, upsert } as const
  }),
  dependencies: [ProfilesRepo.Default]
}) {}
