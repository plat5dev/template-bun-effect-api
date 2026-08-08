import { Model, SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import type { ProjectId } from "../domain/Project.js"
import { Task, TaskId } from "../domain/Task.js"
import { trackDb } from "../plat5/DbMetrics.js"
import { SqlLive } from "../Sql.js"

export class TasksRepo extends Effect.Service<TasksRepo>()("Tasks/Repo", {
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const repo = yield* Model.makeRepository(Task, {
      tableName: "tasks",
      spanPrefix: "TasksRepo",
      idColumn: "id"
    })

    const insert = (row: typeof Task.insert.Type) =>
      repo.insert(row).pipe(
        trackDb("insert"),
        Effect.withSpan("TasksRepo.insert")
      )

    const update = (row: typeof Task.update.Type) =>
      repo.update(row).pipe(
        trackDb("update"),
        Effect.withSpan("TasksRepo.update")
      )

    const findById = (id: TaskId) =>
      repo.findById(id).pipe(
        trackDb("find"),
        Effect.withSpan("TasksRepo.findById")
      )

    const deleteById = (id: TaskId) =>
      repo.delete(id).pipe(
        trackDb("delete"),
        Effect.withSpan("TasksRepo.delete")
      )

    const listByProject = (organizationId: string, projectId: ProjectId) =>
      sql`
        SELECT * FROM tasks
        WHERE organization_id = ${organizationId}
          AND project_id = ${projectId}
        ORDER BY created_at DESC
      `.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(Task))),
        Effect.orDie,
        trackDb("list"),
        Effect.withSpan("TasksRepo.listByProject", {
          attributes: { organizationId, projectId }
        })
      )

    return { insert, update, findById, deleteById, listByProject } as const
  }),
  dependencies: [SqlLive]
}) {}
