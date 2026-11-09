import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlModel, SqlSchema } from "effect/sql"
import { Task, TaskId } from "../domain/Task.js"
import { trackDb } from "../plat5/DbMetrics.js"
import { type Page, trim } from "../plat5/Pagination.js"
import { SqlLive } from "../Sql.js"

const InProject = Schema.Struct({ projectId: Schema.String, id: TaskId })

export class TasksRepo extends Context.Service<TasksRepo>()("api/Tasks/Repo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const repo = yield* SqlModel.makeRepository(Task, {
      tableName: "tasks",
      spanPrefix: "TasksRepo",
      idColumn: "id"
    })

    const insert = Effect.fn("TasksRepo.insert")(
      (row: typeof Task.insert.Type) => repo.insert(row).pipe(Effect.orDie),
      trackDb("tasks.insert")
    )

    const updateRow = SqlSchema.findOneOption({
      Request: Task.update,
      Result: Task,
      execute: (task) =>
        sql`
          UPDATE tasks
          SET title = ${task.title}, status = ${task.status}, assignee_id = ${task.assignee_id},
            updated_at = ${task.updated_at}
          WHERE id = ${task.id} AND project_id = ${task.project_id}
          RETURNING *
        `
    })

    /**
     * Writes the task's fields, scoped by its project. None when no row changed: the task
     * was deleted, or isn't in the project.
     */
    const updateInProject = Effect.fn("TasksRepo.updateInProject")(
      (task: typeof Task.update.Type) => updateRow(task).pipe(Effect.orDie),
      trackDb("tasks.update")
    )

    const findRow = SqlSchema.findOneOption({
      Request: InProject,
      Result: Task,
      execute: ({ id, projectId }) => sql`SELECT * FROM tasks WHERE id = ${id} AND project_id = ${projectId}`
    })

    /** The task, when it is in the project. */
    const findInProject = Effect.fn("TasksRepo.findInProject")(
      (projectId: string, id: TaskId) => findRow({ projectId, id }).pipe(Effect.orDie),
      trackDb("tasks.find")
    )

    /** Deletes the task, scoped by its project. False when no row was deleted. */
    const deleteInProject = Effect.fn("TasksRepo.deleteInProject")(
      (projectId: string, id: TaskId) =>
        sql`DELETE FROM tasks WHERE id = ${id} AND project_id = ${projectId} RETURNING id`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie
        ),
      trackDb("tasks.delete")
    )

    /**
     * Deletes every task of a project, for its purge. Deleting none is fine, so it can
     * run again for the same project.
     */
    const deleteByProject = Effect.fn("TasksRepo.deleteByProject")(
      (projectId: string) => sql`DELETE FROM tasks WHERE project_id = ${projectId}`.pipe(Effect.asVoid, Effect.orDie),
      trackDb("tasks.delete_by_project")
    )

    const listRows = SqlSchema.findAll({
      Request: Schema.Struct({ projectId: Schema.String, startingAfter: Schema.String, limit: Schema.Number }),
      Result: Task,
      execute: ({ limit, projectId, startingAfter }) =>
        sql`
          SELECT * FROM tasks
          WHERE project_id = ${projectId} AND id > ${startingAfter}
          ORDER BY id
          LIMIT ${limit}
        `
    })

    /** One page of the project's tasks in id order, and whether there are more. */
    const listByProject = Effect.fn("TasksRepo.listByProject")(
      (projectId: string, page: Page) =>
        listRows({ projectId, startingAfter: page.startingAfter, limit: page.limit + 1 }).pipe(
          Effect.map((rows) => trim(rows, page)),
          Effect.orDie
        ),
      trackDb("tasks.list")
    )

    return {
      insert,
      updateInProject,
      findInProject,
      deleteInProject,
      deleteByProject,
      listByProject
    } as const
  })
}) {
  static readonly layerNoDeps = Layer.effect(this, this.make)
  static readonly layer = this.layerNoDeps.pipe(Layer.provide(SqlLive))
}
