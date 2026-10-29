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
     * Writes the task's fields, scoped by its environment. Undefined when no row changed:
     * the task was deleted, or isn't in the environment.
     */
    const updateInEnvironment = (task: Task) =>
      sql`
        UPDATE tasks
        SET title = ${task.title}, status = ${task.status}, assignee_id = ${task.assignee_id},
          updated_at = ${task.updated_at}
        WHERE id = ${task.id} AND environment_id = ${task.environment_id}
        RETURNING *
      `.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(Task))),
        Effect.map((rows) => rows[0]),
        Effect.orDie,
        trackDb("tasks.update"),
        Effect.withSpan("TasksRepo.updateInEnvironment")
      )

    /** The task, when it is in the environment. */
    const findInEnvironment = (environmentId: string, id: TaskId) =>
      sql`SELECT * FROM tasks WHERE id = ${id} AND environment_id = ${environmentId}`.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(Task))),
        Effect.map((rows) => rows[0]),
        Effect.orDie,
        trackDb("tasks.find"),
        Effect.withSpan("TasksRepo.findInEnvironment")
      )

    /** Deletes the task, scoped by its environment. False when no row was deleted. */
    const deleteInEnvironment = (environmentId: string, id: TaskId) =>
      sql`DELETE FROM tasks WHERE id = ${id} AND environment_id = ${environmentId} RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
        trackDb("tasks.delete"),
        Effect.withSpan("TasksRepo.deleteInEnvironment")
      )

    /**
     * Deletes every task of an environment, for its purge. Deleting none is fine, so it can
     * run again for the same environment.
     */
    const deleteByEnvironment = (environmentId: string) =>
      sql`DELETE FROM tasks WHERE environment_id = ${environmentId}`.pipe(
        Effect.asVoid,
        Effect.orDie,
        trackDb("tasks.delete_by_environment"),
        Effect.withSpan("TasksRepo.deleteByEnvironment")
      )

    /** One page of the environment's tasks in id order, and whether there are more. */
    const listByEnvironment = (environmentId: string, page: Page) =>
      sql`
        SELECT * FROM tasks
        WHERE environment_id = ${environmentId} AND id > ${page.startingAfter}
        ORDER BY id
        LIMIT ${page.limit + 1}
      `.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(Task))),
        Effect.map((rows) => trim(rows, page)),
        Effect.orDie,
        trackDb("tasks.list"),
        Effect.withSpan("TasksRepo.listByEnvironment")
      )

    return {
      insert,
      updateInEnvironment,
      findInEnvironment,
      deleteInEnvironment,
      deleteByEnvironment,
      listByEnvironment
    } as const
  }),
  dependencies: [SqlLive]
}) {}
