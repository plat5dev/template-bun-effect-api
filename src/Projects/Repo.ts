import { Model, SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { Project, ProjectId } from "../domain/Project.js"
import { trackDb } from "../plat5/DbMetrics.js"
import { type Page, trim } from "../plat5/Pagination.js"
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

    /** One page of the org's projects in id order, and whether there are more. */
    const listByOrganization = (organizationId: string, page: Page) =>
      sql`
        SELECT * FROM projects
        WHERE organization_id = ${organizationId} AND id > ${page.startingAfter}
        ORDER BY id
        LIMIT ${page.limit + 1}
      `.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(Project))),
        Effect.map((rows) => trim(rows, page)),
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
