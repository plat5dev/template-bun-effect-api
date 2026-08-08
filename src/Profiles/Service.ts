import { Effect, Option } from "effect"
import { Profile } from "../domain/Profile.js"
import { notFound } from "../plat5/Errors.js"
import { ProfilesRepo } from "./Repo.js"

const now = () => new Date().toISOString()

export class Profiles extends Effect.Service<Profiles>()("Profiles", {
  effect: Effect.gen(function*() {
    const repo = yield* ProfilesRepo

    const getByUserId = (userId: string) =>
      repo.findByUserId(userId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(notFound("profile", userId)),
            onSome: Effect.succeed
          })
        ),
        Effect.withSpan("Profiles.getByUserId", { attributes: { userId } })
      )

    const getOrCreateMe = (userId: string) =>
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
      }).pipe(Effect.withSpan("Profiles.getOrCreateMe", { attributes: { userId } }))

    const upsertMe = (
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
      }).pipe(Effect.withSpan("Profiles.upsertMe", { attributes: { userId } }))

    return { getByUserId, getOrCreateMe, upsertMe } as const
  }),
  dependencies: [ProfilesRepo.Default]
}) {}
