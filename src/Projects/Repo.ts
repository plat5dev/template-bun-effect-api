import { Model, SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { Project, ProjectId } from "../domain/Project.js"
import { trackDb } from "../plat5/DbMetrics.js"
import { SqlLive } from "../Sql.js"

export class ProjectsRepo extends Effect.Service<ProjectsRepo>()("Projects/Repo", {
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const repo = yield* Model.makeRepository(Project, {
      tableName: "projects",
      spanPrefix: "ProjectsRepo",
      idColumn: "id"
    })

    const insert = (row: typeof Project.insert.Type) =>
      repo.insert(row).pipe(
        trackDb("insert"),
        Effect.withSpan("ProjectsRepo.insert")
      )

    const update = (row: typeof Project.update.Type) =>
      repo.update(row).pipe(
        trackDb("update"),
        Effect.withSpan("ProjectsRepo.update")
      )

    const findById = (id: ProjectId) =>
      repo.findById(id).pipe(
        trackDb("find"),
        Effect.withSpan("ProjectsRepo.findById")
      )

    const deleteById = (id: ProjectId) =>
      repo.delete(id).pipe(
        trackDb("delete"),
        Effect.withSpan("ProjectsRepo.delete")
      )

    const listByOrganization = (organizationId: string) =>
      sql`
        SELECT * FROM projects
        WHERE organization_id = ${organizationId}
        ORDER BY created_at DESC
      `.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(Project))),
        Effect.orDie,
        trackDb("list"),
        Effect.withSpan("ProjectsRepo.listByOrganization", {
          attributes: { organizationId }
        })
      )

    return { insert, update, findById, deleteById, listByOrganization } as const
  }),
  dependencies: [SqlLive]
}) {}
