/**
 * Project tasks: model, SQLite repository, service, and HttpApi group.
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { Model } from "effect/schema"
import { SqlClient, SqlSchema } from "effect/sql"
import { monotonicFactory } from "ulid"
import { Access } from "./Access.js"
import * as Audit from "./plat5/Audit.js"
import { HttpErrors, NotFound, Plat5Query, Plat5Request, ServiceUnavailable, ValidationFailed } from "./plat5/Errors.js"
import { ListParams, type Page, pageOf, trim, Ulid } from "./plat5/Pagination.js"

const ulid = monotonicFactory()

export const MEMBER_HEADER = "x-plat5-member-id"
/** Permission a task's assignee must hold on the project (matches services/api.yml's read permission). */
export const ASSIGNEE_PERMISSION = "project:read"

export const TaskId = Schema.String.pipe(Schema.brand("TaskId"))
export type TaskId = typeof TaskId.Type

export const TaskStatus = Schema.Literals(["todo", "in_progress", "done"]).annotate({
  message: "Status must be todo, in progress, or done."
})
export type TaskStatus = typeof TaskStatus.Type

export class Task extends Model.Class<Task>("Task")({
  id: Model.GeneratedByApp(TaskId),
  project_id: Model.GeneratedByApp(Schema.String),
  title: Schema.String,
  status: TaskStatus,
  assignee_id: Schema.NullOr(Schema.String),
  created_by: Model.GeneratedByApp(Schema.String),
  created_at: Model.DateTimeInsert,
  updated_at: Model.DateTimeUpdate
}) {}

const Title = Schema.Trim.check(
  Schema.isMinCodePoints(1, { message: "Title is required." }),
  Schema.isMaxCodePoints(255, { message: "Title is too long." })
).annotate({ description: "Trimmed of white space, then 1 to 255 characters." })

const AssigneeId = Schema.NullOr(Ulid).annotate({
  description: "A member id in the project's tree who can see the project, or null for none."
})

export const TaskCreate = Schema.Struct({
  title: Title.pipe(Schema.annotateKey({ messageMissingKey: "Title is required." })),
  status: Schema.optionalKey(TaskStatus),
  assignee_id: Schema.optionalKey(AssigneeId)
})
export type TaskCreate = typeof TaskCreate.Type

export const TaskUpdate = Schema.Struct({
  title: Schema.optionalKey(Schema.NullOr(Title)),
  status: Schema.optionalKey(Schema.NullOr(TaskStatus)),
  assignee_id: Schema.optionalKey(AssigneeId)
})
export type TaskUpdate = typeof TaskUpdate.Type

const InProject = Schema.Struct({ projectId: Schema.String, id: TaskId })

export class TasksRepo extends Context.Service<TasksRepo>()("api/TasksRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const insertRow = SqlSchema.findOne({
      Request: Task.insert,
      Result: Task,
      execute: (row) => sql`INSERT INTO tasks ${sql.insert({ ...row, updated_at: row.created_at })} RETURNING *`
    })

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

    const findRow = SqlSchema.findOneOption({
      Request: InProject,
      Result: Task,
      execute: ({ id, projectId }) => sql`SELECT * FROM tasks WHERE id = ${id} AND project_id = ${projectId}`
    })

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

    const insert = Effect.fn("TasksRepo.insert")(
      (row: typeof Task.insert.Type) =>
        insertRow(row).pipe(Effect.catchTag(["SchemaError", "NoSuchElementError"], Effect.die))
    )

    const updateInProject = Effect.fn("TasksRepo.updateInProject")(
      (task: typeof Task.update.Type) => updateRow(task).pipe(Effect.catchTag("SchemaError", Effect.die))
    )

    const findInProject = Effect.fn("TasksRepo.findInProject")(
      (projectId: string, id: TaskId) => findRow({ projectId, id }).pipe(Effect.catchTag("SchemaError", Effect.die))
    )

    const deleteInProject = Effect.fn("TasksRepo.deleteInProject")(
      (projectId: string, id: TaskId) =>
        sql`DELETE FROM tasks WHERE id = ${id} AND project_id = ${projectId} RETURNING id`.pipe(
          Effect.map((rows) => rows.length > 0)
        )
    )

    const deleteByProject = Effect.fn("TasksRepo.deleteByProject")(
      (projectId: string) => sql`DELETE FROM tasks WHERE project_id = ${projectId}`.pipe(Effect.asVoid)
    )

    const listByProject = Effect.fn("TasksRepo.listByProject")(
      (projectId: string, page: Page) =>
        listRows({ projectId, startingAfter: page.startingAfter, limit: page.limit + 1 }).pipe(
          Effect.map((rows) => trim(rows, page)),
          Effect.catchTag("SchemaError", Effect.die)
        )
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
  static readonly layer = Layer.effect(this, this.make)
}

export class Tasks extends Context.Service<Tasks>()("api/Tasks", {
  make: Effect.gen(function*() {
    const repo = yield* TasksRepo
    const access = yield* Access

    const checkAssignee = Effect.fnUntraced(function*(projectId: string, assigneeId: string) {
      const allowed = yield* access.evaluate({
        memberId: assigneeId,
        kind: "project",
        nodeId: projectId,
        permission: ASSIGNEE_PERMISSION
      }).pipe(Effect.mapError(() => new ServiceUnavailable()))
      if (!allowed) {
        return yield* ValidationFailed.field("assignee_id", "That person can't see this project.")
      }
    })

    const list = Effect.fn("Tasks.list")(function*(projectId: string, params: ListParams) {
      yield* Effect.annotateCurrentSpan("plat5.node_id", projectId)
      return yield* repo.listByProject(projectId, pageOf(params))
    })

    const create = Effect.fn("Tasks.create")(function*(projectId: string, memberId: string, input: TaskCreate) {
      yield* Effect.annotateCurrentSpan("plat5.node_id", projectId)
      const assigneeId = input.assignee_id ?? null
      if (assigneeId !== null) yield* checkAssignee(projectId, assigneeId)

      const row = yield* Task.insert.makeEffect({
        id: TaskId.make(ulid().toLowerCase()),
        project_id: projectId,
        title: input.title,
        status: input.status ?? "todo",
        assignee_id: assigneeId,
        created_by: memberId
      }).pipe(Effect.orDie)
      const task = yield* repo.insert(row)

      yield* Audit.setDetails({
        task_id: task.id,
        title: task.title,
        status: task.status,
        assignee_id: task.assignee_id
      })
      yield* Audit.setCreated(task.id)
      return task
    })

    const getInProject = Effect.fn("Tasks.getInProject")(function*(projectId: string, taskId: string) {
      yield* Effect.annotateCurrentSpan({ "plat5.node_id": projectId, task_id: taskId })
      const task = yield* repo.findInProject(projectId, TaskId.make(taskId))
      if (Option.isNone(task)) return yield* new NotFound({ resource: "task", id: taskId })
      return task.value
    })

    const update = Effect.fn("Tasks.update")(function*(projectId: string, taskId: string, input: TaskUpdate) {
      yield* Effect.annotateCurrentSpan({ "plat5.node_id": projectId, task_id: taskId })
      const task = yield* getInProject(projectId, taskId)
      if (typeof input.assignee_id === "string") {
        yield* checkAssignee(projectId, input.assignee_id)
      }

      const nextTitle = input.title ?? task.title
      const nextStatus = input.status ?? task.status
      const nextAssignee = input.assignee_id === undefined ? task.assignee_id : input.assignee_id

      if (nextTitle === task.title && nextStatus === task.status && nextAssignee === task.assignee_id) {
        return task
      }

      const patch = yield* Task.update.makeEffect({
        id: task.id,
        project_id: task.project_id,
        created_by: task.created_by,
        title: nextTitle,
        status: nextStatus,
        assignee_id: nextAssignee
      }).pipe(Effect.orDie)
      const updated = yield* repo.updateInProject(patch)
      if (Option.isNone(updated)) return yield* new NotFound({ resource: "task", id: taskId })

      const changes: Audit.Details = {}
      Audit.changed(changes, "title", task.title, updated.value.title)
      Audit.changed(changes, "status", task.status, updated.value.status)
      Audit.changed(changes, "assignee_id", task.assignee_id, updated.value.assignee_id)
      yield* Audit.setDetails(changes)
      return updated.value
    })

    const remove = Effect.fn("Tasks.remove")(function*(projectId: string, taskId: string) {
      yield* Effect.annotateCurrentSpan({ "plat5.node_id": projectId, task_id: taskId })
      const deleted = yield* repo.deleteInProject(projectId, TaskId.make(taskId))
      if (!deleted) return yield* new NotFound({ resource: "task", id: taskId })
    })

    return { list, create, getInProject, update, remove } as const
  })
}) {
  static readonly layer = Layer.effect(this, this.make)
}

const TaskJson = Task.json.annotate({ identifier: "Task" })
const ProjectPath = { project_id: Schema.String }
const TaskPath = { project_id: Schema.String, task_id: Schema.String }
const CreateHeaders = { [MEMBER_HEADER]: Schema.NonEmptyString }

export class TasksApi extends HttpApiGroup.make("tasks")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: ProjectPath,
      query: ListParams,
      success: Schema.Struct({ tasks: Schema.Array(TaskJson), has_more: Schema.Boolean })
    }).middleware(Plat5Query),
    HttpApiEndpoint.post("create", "/", {
      params: ProjectPath,
      headers: CreateHeaders,
      payload: TaskCreate,
      success: TaskJson.pipe(HttpApiSchema.status(201)),
      error: [HttpErrors.ValidationFailed, HttpErrors.ServiceUnavailable]
    }).middleware(Plat5Request),
    HttpApiEndpoint.get("get", "/:task_id", {
      params: TaskPath,
      success: TaskJson,
      error: HttpErrors.NotFound
    }),
    HttpApiEndpoint.patch("update", "/:task_id", {
      params: TaskPath,
      payload: TaskUpdate,
      success: TaskJson,
      error: [HttpErrors.NotFound, HttpErrors.ValidationFailed, HttpErrors.ServiceUnavailable]
    }).middleware(Plat5Request),
    HttpApiEndpoint.delete("remove", "/:task_id", {
      params: TaskPath,
      error: HttpErrors.NotFound
    })
  )
  .prefix("/projects/:project_id/tasks")
  .annotateMerge(OpenApi.annotations({ title: "Tasks", description: "Tasks inside a project" }))
{}
