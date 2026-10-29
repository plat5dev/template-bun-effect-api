import { Model, SqlClient } from "@effect/sql"
import { Effect, Option } from "effect"
import { Profile } from "../domain/Profile.js"
import { trackDb } from "../plat5/DbMetrics.js"
import { SqlLive } from "../Sql.js"

export class ProfilesRepo extends Effect.Service<ProfilesRepo>()("Profiles/Repo", {
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const repo = yield* Model.makeRepository(Profile, {
      tableName: "profiles",
      spanPrefix: "ProfilesRepo",
      idColumn: "user_id"
    })

    const findByUserId = (userId: string) =>
      repo.findById(userId).pipe(
        trackDb("profiles.find"),
        Effect.withSpan("ProfilesRepo.findByUserId")
      )

    const insert = (row: typeof Profile.insert.Type) =>
      repo.insert(row).pipe(
        trackDb("profiles.insert"),
        Effect.withSpan("ProfilesRepo.insert")
      )

    const update = (row: typeof Profile.update.Type) =>
      repo.update(row).pipe(
        trackDb("profiles.update"),
        Effect.withSpan("ProfilesRepo.update")
      )

    const upsert = (row: typeof Profile.insert.Type) =>
      Effect.gen(function*() {
        const existing = yield* findByUserId(row.user_id)
        if (Option.isSome(existing)) {
          return yield* update({
            ...existing.value,
            bio: row.bio,
            updated_at: row.updated_at
          })
        }
        return yield* insert(row)
      }).pipe(Effect.withSpan("ProfilesRepo.upsert"))

    /**
     * Deletes the person's profile, with their account. Deleting none is fine, so it can run
     * again for the same person.
     */
    const deleteByUserId = (userId: string) =>
      repo.delete(userId).pipe(
        trackDb("profiles.delete"),
        Effect.withSpan("ProfilesRepo.deleteByUserId")
      )

    return { findByUserId, insert, update, upsert, deleteByUserId, sql } as const
  }),
  dependencies: [SqlLive]
}) {}
