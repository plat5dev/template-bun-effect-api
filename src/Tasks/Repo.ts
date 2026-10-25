import { Model, SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { Task, TaskId } from "../domain/Task.js"
import { trackDb } from "../plat5/DbMetrics.js"
import { type Page, trim } from "../plat5/Pagination.js"
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

    /** The task, when it is in the project. */
    const findInProject = (projectId: string, id: TaskId) =>
      sql`SELECT * FROM tasks WHERE id = ${id} AND project_id = ${projectId}`.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(Task))),
        Effect.map((rows) => rows[0]),
        Effect.orDie,
        trackDb("find"),
        Effect.withSpan("TasksRepo.findInProject")
      )

    const deleteById = (id: TaskId) =>
      repo.delete(id).pipe(
        trackDb("delete"),
        Effect.withSpan("TasksRepo.delete")
      )

    /**
     * Deletes every task of a project, for its purge. Deleting none is fine, so it can run
     * again for the same project.
     */
    const deleteByProject = (projectId: string) =>
      sql`DELETE FROM tasks WHERE project_id = ${projectId}`.pipe(
        Effect.asVoid,
        Effect.orDie,
        trackDb("delete_by_project"),
        Effect.withSpan("TasksRepo.deleteByProject")
      )

    /** One page of the project's tasks in id order, and whether there are more. */
    const listByProject = (projectId: string, page: Page) =>
      sql`
        SELECT * FROM tasks
        WHERE project_id = ${projectId} AND id > ${page.startingAfter}
        ORDER BY id
        LIMIT ${page.limit + 1}
      `.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(Task))),
        Effect.map((rows) => trim(rows, page)),
        Effect.orDie,
        trackDb("list"),
        Effect.withSpan("TasksRepo.listByProject")
      )

    return { insert, update, findInProject, deleteById, deleteByProject, listByProject } as const
  }),
  dependencies: [SqlLive]
}) {}
