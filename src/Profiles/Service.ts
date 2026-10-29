import { Effect, Option } from "effect"
import { Profile } from "../domain/Profile.js"
import * as Audit from "../plat5/Audit.js"
import { charLength, type Fields, optionalString } from "../plat5/Body.js"
import { now } from "../plat5/Clock.js"
import { fieldError } from "../plat5/Errors.js"
import { ProfilesRepo } from "./Repo.js"

/** A bio's longest, in characters. */
const MAX_BIO = 2000

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

    /** `bio` is required, and kept as sent: not trimmed, and "" is a bio. */
    const upsert = (userId: string, fields: Fields) =>
      Effect.gen(function*() {
        const bio = yield* optionalString(fields, "bio")
        if (bio === undefined) {
          return yield* Effect.fail(fieldError("bio", "Bio is required."))
        }
        if (charLength(bio) > MAX_BIO) {
          return yield* Effect.fail(fieldError("bio", "Bio is too long."))
        }
        const ts = now()
        const existing = yield* repo.findByUserId(userId)
        if (Option.isSome(existing)) {
          const before = existing.value
          const updated = yield* repo.update({
            ...before,
            bio,
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
            bio,
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
