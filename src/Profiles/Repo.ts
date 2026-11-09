import { Context, Effect, Layer, Option } from "effect"
import { SqlClient, SqlModel, SqlSchema } from "effect/sql"
import { Profile } from "../domain/Profile.js"
import { trackDb } from "../plat5/DbMetrics.js"
import { SqlLive } from "../Sql.js"

export class ProfilesRepo extends Context.Service<ProfilesRepo>()("api/Profiles/Repo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const repo = yield* SqlModel.makeRepository(Profile, {
      tableName: "profiles",
      spanPrefix: "ProfilesRepo",
      idColumn: "user_id"
    })

    /** The person's profile, or none yet. */
    const findByUserId = Effect.fn("ProfilesRepo.findByUserId")(
      (userId: string) =>
        repo.findById(userId).pipe(
          Effect.map(Option.some),
          Effect.catchTag("NoSuchElementError", () => Effect.succeedNone),
          Effect.orDie
        ),
      trackDb("profiles.find")
    )

    const insertIfAbsent = SqlSchema.void({
      Request: Profile.insert,
      execute: (row) => sql`INSERT INTO profiles ${sql.insert(row)} ON CONFLICT (user_id) DO NOTHING`
    })

    /** The person's profile, made from `row` if they have none: two first reads make one. */
    const getOrInsert = Effect.fn("ProfilesRepo.getOrInsert")(
      (row: typeof Profile.insert.Type) =>
        insertIfAbsent(row).pipe(
          Effect.andThen(repo.findById(row.user_id)),
          Effect.orDie
        ),
      trackDb("profiles.get_or_insert")
    )

    const upsertRow = SqlSchema.findOne({
      Request: Profile.insert,
      Result: Profile,
      execute: (row) =>
        sql`
          INSERT INTO profiles ${sql.insert(row)}
          ON CONFLICT (user_id) DO UPDATE SET bio = excluded.bio, updated_at = excluded.updated_at
          RETURNING *
        `
    })

    /** Writes the person's bio, making their profile if they have none. */
    const upsert = Effect.fn("ProfilesRepo.upsert")(
      (row: typeof Profile.insert.Type) => upsertRow(row).pipe(Effect.orDie),
      trackDb("profiles.upsert")
    )

    /**
     * Deletes the person's profile, with their account. Deleting none is fine, so it can run
     * again for the same person.
     */
    const deleteByUserId = Effect.fn("ProfilesRepo.deleteByUserId")(
      (userId: string) => repo.delete(userId).pipe(Effect.orDie),
      trackDb("profiles.delete")
    )

    return { findByUserId, getOrInsert, upsert, deleteByUserId } as const
  })
}) {
  static readonly layerNoDeps = Layer.effect(this, this.make)
  static readonly layer = this.layerNoDeps.pipe(Layer.provide(SqlLive))
}
