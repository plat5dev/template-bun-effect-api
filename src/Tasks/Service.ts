import { Context, Effect, Layer, Option } from "effect"
import { monotonicFactory } from "ulid"
import { Access } from "../Access.js"
import { AppConfig } from "../AppConfig.js"
import { Task, type TaskCreate, TaskId, type TaskUpdate } from "../domain/Task.js"
import * as Audit from "../plat5/Audit.js"
import { NotFound, ServiceUnavailable, ValidationFailed } from "../plat5/Errors.js"
import { type ListParams, pageOf } from "../plat5/Pagination.js"
import { TasksRepo } from "./Repo.js"

// Monotonic, so tasks made in the same millisecond still list in the order they were made.
const ulid = monotonicFactory()

// Every call scopes its reads and writes by the project id in the path, and checks nothing
// about the caller or the project: the front door decided who may call, on which project.
// The bodies come checked (src/domain/Task.ts); a write checks, on an update, the task, then
// the assignee, by identity's answer, before writing.
export class Tasks extends Context.Service<Tasks>()("api/Tasks", {
  make: Effect.gen(function*() {
    const repo = yield* TasksRepo
    const access = yield* Access
    const config = yield* AppConfig

    /**
     * Asks identity whether the assignee holds `TASK_ASSIGNEE_PERMISSION` on the project.
     * The caller may assign, but the assignee isn't the caller, so the front door decided
     * nothing about them
     * (plat5 docs/guides/write-a-service.md#checking-access-outside-a-request). No answer
     * is no: a 503, so nothing is written.
     */
    const checkAssignee = Effect.fnUntraced(function*(projectId: string, assigneeId: string) {
      const allowed = yield* access.evaluate({
        memberId: assigneeId,
        kind: "project",
        nodeId: projectId,
        permission: config.taskAssigneePermission
      }).pipe(Effect.mapError(() => new ServiceUnavailable()))
      if (!allowed) {
        return yield* ValidationFailed.field("assignee_id", "That person can't see this project.")
      }
    })

    const list = Effect.fn("Tasks.list")(function*(projectId: string, params: ListParams) {
      yield* Effect.annotateCurrentSpan("plat5.node_id", projectId)
      return yield* repo.listByProject(projectId, pageOf(params))
    })

    /** Records `memberId`, the caller's, as the author. */
    const create = Effect.fn("Tasks.create")(function*(projectId: string, memberId: string, input: TaskCreate) {
      yield* Effect.annotateCurrentSpan("plat5.node_id", projectId)
      const assigneeId = input.assignee_id ?? null
      if (assigneeId !== null) {
        yield* checkAssignee(projectId, assigneeId)
      }
      const task = yield* Task.insert.makeEffect({
        id: TaskId.make(ulid().toLowerCase()),
        project_id: projectId,
        title: input.title,
        status: input.status ?? "todo",
        assignee_id: assigneeId,
        created_by: memberId
      }).pipe(Effect.orDie, Effect.flatMap(repo.insert))
      yield* Audit.setDetails({
        task_id: task.id,
        title: task.title,
        status: task.status,
        assignee_id: task.assignee_id
      })
      yield* Audit.setCreated(task.id)
      return task
    })

    /** The task, or a 404 when there is none by that id in the project. */
    const getInProject = Effect.fn("Tasks.getInProject")(function*(projectId: string, taskId: string) {
      yield* Effect.annotateCurrentSpan({ "plat5.node_id": projectId, task_id: taskId })
      const task = yield* repo.findInProject(projectId, TaskId.make(taskId))
      if (Option.isNone(task)) {
        return yield* new NotFound({ resource: "task", id: taskId })
      }
      return task.value
    })

    /**
     * A field absent or null leaves the task's as it is, but for `assignee_id`: null
     * unassigns. `updated_at` moves on every update, even one that changes nothing.
     */
    const update = Effect.fn("Tasks.update")(function*(projectId: string, taskId: string, input: TaskUpdate) {
      yield* Effect.annotateCurrentSpan({ "plat5.node_id": projectId, task_id: taskId })
      const task = yield* getInProject(projectId, taskId)
      // Absent and null have nothing to check.
      if (typeof input.assignee_id === "string") {
        yield* checkAssignee(projectId, input.assignee_id)
      }
      const updated = yield* Task.update.makeEffect({
        id: task.id,
        project_id: task.project_id,
        created_by: task.created_by,
        title: input.title ?? task.title,
        status: input.status ?? task.status,
        assignee_id: input.assignee_id === undefined ? task.assignee_id : input.assignee_id
      }).pipe(Effect.orDie, Effect.flatMap(repo.updateInProject))
      // Deleted since it was read.
      if (Option.isNone(updated)) {
        return yield* new NotFound({ resource: "task", id: taskId })
      }
      const changes: Audit.Details = {}
      Audit.changed(changes, "title", task.title, updated.value.title)
      Audit.changed(changes, "status", task.status, updated.value.status)
      Audit.changed(changes, "assignee_id", task.assignee_id, updated.value.assignee_id)
      yield* Audit.setDetails(changes)
      return updated.value
    })

    const remove = Effect.fn("Tasks.remove")(function*(projectId: string, taskId: string) {
      yield* Effect.annotateCurrentSpan({ "plat5.node_id": projectId, task_id: taskId })
      yield* getInProject(projectId, taskId)
      const deleted = yield* repo.deleteInProject(projectId, TaskId.make(taskId))
      // Deleted since it was read.
      if (!deleted) {
        return yield* new NotFound({ resource: "task", id: taskId })
      }
      // No audit details: the route and the task id in its path say what happened.
    })

    return { list, create, getInProject, update, remove } as const
  })
}) {
  static readonly layerNoDeps = Layer.effect(this, this.make)
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide([TasksRepo.layer, Access.layer, AppConfig.layer])
  )
}
