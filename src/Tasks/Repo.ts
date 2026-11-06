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
        trackDb("tasks.insert"),
        Effect.withSpan("TasksRepo.insert")
      )

    /**
     * Writes the task's fields, scoped by its project. Undefined when no row changed:
     * the task was deleted, or isn't in the project.
     */
    const updateInProject = (task: Task) =>
      sql`
        UPDATE tasks
        SET title = ${task.title}, status = ${task.status}, assignee_id = ${task.assignee_id},
          updated_at = ${task.updated_at}
        WHERE id = ${task.id} AND project_id = ${task.project_id}
        RETURNING *
      `.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(Task))),
        Effect.map((rows) => rows[0]),
        Effect.orDie,
        trackDb("tasks.update"),
        Effect.withSpan("TasksRepo.updateInProject")
      )

    /** The task, when it is in the project. */
    const findInProject = (projectId: string, id: TaskId) =>
      sql`SELECT * FROM tasks WHERE id = ${id} AND project_id = ${projectId}`.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(Task))),
        Effect.map((rows) => rows[0]),
        Effect.orDie,
        trackDb("tasks.find"),
        Effect.withSpan("TasksRepo.findInProject")
      )

    /** Deletes the task, scoped by its project. False when no row was deleted. */
    const deleteInProject = (projectId: string, id: TaskId) =>
      sql`DELETE FROM tasks WHERE id = ${id} AND project_id = ${projectId} RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
        trackDb("tasks.delete"),
        Effect.withSpan("TasksRepo.deleteInProject")
      )

    /**
     * Deletes every task of a project, for its purge. Deleting none is fine, so it can
     * run again for the same project.
     */
    const deleteByProject = (projectId: string) =>
      sql`DELETE FROM tasks WHERE project_id = ${projectId}`.pipe(
        Effect.asVoid,
        Effect.orDie,
        trackDb("tasks.delete_by_project"),
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
        trackDb("tasks.list"),
        Effect.withSpan("TasksRepo.listByProject")
      )

    return {
      insert,
      updateInProject,
      findInProject,
      deleteInProject,
      deleteByProject,
      listByProject
    } as const
  }),
  dependencies: [SqlLive]
}) {}
