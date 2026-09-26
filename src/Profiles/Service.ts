import { Effect, Option } from "effect"
import { Profile } from "../domain/Profile.js"
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
          return yield* repo.update({
            ...existing.value,
            display_name: payload.display_name,
            bio: payload.bio ?? existing.value.bio,
            updated_at: ts
          })
        }
        return yield* repo.insert(
          Profile.insert.make({
            user_id: userId,
            display_name: payload.display_name,
            bio: payload.bio ?? "",
            created_at: ts,
            updated_at: ts
          })
        )
      }).pipe(Effect.withSpan("Profiles.upsert", { attributes: { userId } }))

    return { getOrCreate, upsert } as const
  }),
  dependencies: [ProfilesRepo.Default]
}) {}
