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

    /** The task, when it is in the environment. */
    const findInEnvironment = (environmentId: string, id: TaskId) =>
      sql`SELECT * FROM tasks WHERE id = ${id} AND environment_id = ${environmentId}`.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(Task))),
        Effect.map((rows) => rows[0]),
        Effect.orDie,
        trackDb("find"),
        Effect.withSpan("TasksRepo.findInEnvironment")
      )

    const deleteById = (id: TaskId) =>
      repo.delete(id).pipe(
        trackDb("delete"),
        Effect.withSpan("TasksRepo.delete")
      )

    /**
     * Deletes every task of an environment, for its purge. Deleting none is fine, so it can
     * run again for the same environment.
     */
    const deleteByEnvironment = (environmentId: string) =>
      sql`DELETE FROM tasks WHERE environment_id = ${environmentId}`.pipe(
        Effect.asVoid,
        Effect.orDie,
        trackDb("delete_by_environment"),
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
        trackDb("list"),
        Effect.withSpan("TasksRepo.listByEnvironment")
      )

    return { insert, update, findInEnvironment, deleteById, deleteByEnvironment, listByEnvironment } as const
  }),
  dependencies: [SqlLive]
}) {}
