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
            display_name: "Anonymous",
            bio: "",
            created_at: ts,
            updated_at: ts
          })
        )
      }).pipe(Effect.withSpan("Profiles.getOrCreate", { attributes: { userId } }))

    const upsert = (
      userId: string,
      payload: { display_name: string; bio?: string }
    ) =>
      Effect.gen(function*() {
        const ts = now()
        const existing = yield* repo.findByUserId(userId)
        if (Option.isSome(existing)) {
          const before = existing.value
          const updated = yield* repo.update({
            ...before,
            display_name: payload.display_name,
            bio: payload.bio ?? before.bio,
            updated_at: ts
          })
          const changes: Audit.Details = {}
          Audit.changed(changes, "display_name", before.display_name, updated.display_name)
          Audit.changed(changes, "bio", before.bio, updated.bio)
          yield* Audit.setDetails(changes)
          return updated
        }
        const created = yield* repo.insert(
          Profile.insert.make({
            user_id: userId,
            display_name: payload.display_name,
            bio: payload.bio ?? "",
            created_at: ts,
            updated_at: ts
          })
        )
        // A new profile: each field changed from nothing. The profile's id is the user's,
        // which the path already carries, so there is no created id.
        const changes: Audit.Details = {
          display_name: { from: null, to: created.display_name }
        }
        if (created.bio) changes.bio = { from: null, to: created.bio }
        yield* Audit.setDetails(changes)
        return created
      }).pipe(Effect.withSpan("Profiles.upsert", { attributes: { userId } }))

    return { getOrCreate, upsert } as const
  }),
  dependencies: [ProfilesRepo.Default]
}) {}
