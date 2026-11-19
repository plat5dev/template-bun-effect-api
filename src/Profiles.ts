/**
 * User profiles: model, SQLite repository, service, and HttpApi group.
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Model } from "effect/schema"
import { SqlClient, SqlSchema } from "effect/sql"
import * as Audit from "./plat5/Audit.js"
import { Plat5Request } from "./plat5/Errors.js"

export class Profile extends Model.Class<Profile>("Profile")({
  user_id: Model.GeneratedByApp(Schema.String),
  bio: Schema.String,
  created_at: Model.DateTimeInsert,
  updated_at: Model.DateTimeUpdate
}) {}

export const ProfileUpdate = Schema.Struct({
  bio: Schema.String.check(Schema.isMaxCodePoints(2000, { message: "Bio is too long." })).pipe(
    Schema.annotate({ description: "At most 2000 characters, kept as sent." }),
    Schema.annotateKey({ messageMissingKey: "Bio is required." })
  )
})
export type ProfileUpdate = typeof ProfileUpdate.Type

export class ProfilesRepo extends Context.Service<ProfilesRepo>()("api/ProfilesRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const findRow = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Profile,
      execute: (userId) => sql`SELECT * FROM profiles WHERE user_id = ${userId}`
    })

    const insertIfAbsent = SqlSchema.void({
      Request: Profile.insert,
      execute: (row) => sql`INSERT INTO profiles ${sql.insert(row)} ON CONFLICT (user_id) DO NOTHING`
    })

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

    const findByUserId = Effect.fn("ProfilesRepo.findByUserId")(
      (userId: string) => findRow(userId).pipe(Effect.catchTag("SchemaError", Effect.die))
    )

    const getOrInsert = Effect.fn("ProfilesRepo.getOrInsert")(
      (row: typeof Profile.insert.Type) =>
        insertIfAbsent(row).pipe(
          Effect.andThen(findRow(row.user_id)),
          Effect.flatMap(Option.match({
            onNone: () => Effect.die(new Error(`Profile missing after insert: ${row.user_id}`)),
            onSome: Effect.succeed
          })),
          Effect.catchTag("SchemaError", Effect.die),
          sql.withTransaction
        )
    )

    const upsert = Effect.fn("ProfilesRepo.upsert")(
      (row: typeof Profile.insert.Type) =>
        Effect.gen(function*() {
          const before = yield* findRow(row.user_id)
          const after = yield* upsertRow(row)
          return { before, after } as const
        }).pipe(
          Effect.catchTag(["SchemaError", "NoSuchElementError"], Effect.die),
          sql.withTransaction
        )
    )

    const deleteByUserId = Effect.fn("ProfilesRepo.deleteByUserId")(
      (userId: string) => sql`DELETE FROM profiles WHERE user_id = ${userId}`.pipe(Effect.asVoid)
    )

    return { findByUserId, getOrInsert, upsert, deleteByUserId } as const
  })
}) {
  static readonly layer = Layer.effect(this, this.make)
}

export class Profiles extends Context.Service<Profiles>()("api/Profiles", {
  make: Effect.gen(function*() {
    const repo = yield* ProfilesRepo

    const getOrCreate = Effect.fn("Profiles.getOrCreate")(function*(userId: string) {
      yield* Effect.annotateCurrentSpan("plat5.user_id", userId)
      const row = yield* Profile.insert.makeEffect({ user_id: userId, bio: "" }).pipe(Effect.orDie)
      return yield* repo.getOrInsert(row)
    })

    const upsert = Effect.fn("Profiles.upsert")(function*(userId: string, input: ProfileUpdate) {
      yield* Effect.annotateCurrentSpan("plat5.user_id", userId)
      const row = yield* Profile.insert.makeEffect({ user_id: userId, bio: input.bio }).pipe(Effect.orDie)
      const { after, before } = yield* repo.upsert(row)
      const changes: Audit.Details = {}
      Audit.changed(changes, "bio", Option.match(before, { onNone: () => null, onSome: (p) => p.bio }), after.bio)
      yield* Audit.setDetails(changes)
      return after
    })

    return { getOrCreate, upsert } as const
  })
}) {
  static readonly layer = Layer.effect(this, this.make)
}

const ProfileJson = Profile.json.annotate({ identifier: "Profile" })
const UserPath = { user_id: Schema.String }

export class ProfilesApi extends HttpApiGroup.make("profiles")
  .add(
    HttpApiEndpoint.get("get", "/", {
      params: UserPath,
      success: ProfileJson
    }),
    HttpApiEndpoint.put("upsert", "/", {
      params: UserPath,
      payload: ProfileUpdate,
      success: ProfileJson
    }).middleware(Plat5Request)
  )
  .prefix("/users/:user_id/profile")
  .annotateMerge(OpenApi.annotations({ title: "Profiles", description: "The person's own profile" }))
{}
