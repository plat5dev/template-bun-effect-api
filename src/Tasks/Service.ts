import { Effect } from "effect"
import { monotonicFactory } from "ulid"
import { Access } from "../Access.js"
import { AppConfig } from "../AppConfig.js"
import { Task, TaskId, type TaskStatus } from "../domain/Task.js"
import * as Audit from "../plat5/Audit.js"
import { fieldError, invalidRequest, notFound, serviceUnavailable } from "../plat5/Errors.js"
import { type ListParams, parsePage } from "../plat5/Pagination.js"
import { TasksRepo } from "./Repo.js"

const now = () => new Date().toISOString()

// Monotonic, so tasks made in the same millisecond still list in the order they were made.
const ulid = monotonicFactory()

/**
 * What checking an assignee needs from the front door: the environment's project id, from
 * `X-Plat5-Project-Id`, and the request's `X-Request-ID` ("" without one).
 */
export type FrontDoor = {
  readonly projectId: string | undefined
  readonly requestId: string
}

// Every call scopes its lookups by the environment id in the path, and checks nothing
// about the caller or the environment: the front door decided who may call, on which
// environment. A write that sets an assignee checks the assignee, in this order: the body,
// the task (on an update), the project id, then identity's answer, before writing.
export class Tasks extends Effect.Service<Tasks>()("Tasks", {
  effect: Effect.gen(function*() {
    const repo = yield* TasksRepo
    const access = yield* Access
    const config = yield* AppConfig

    /**
     * Asks identity whether the assignee holds `TASK_ASSIGNEE_PERMISSION` on the
     * environment's project. The caller may assign, but the assignee isn't the caller, so
     * the front door decided nothing about them
     * (plat5 docs/guides/write-a-service.md#checking-access-outside-a-request). No answer
     * is no: a 503, so nothing is written.
     */
    const checkAssignee = (assigneeId: string, from: FrontDoor) =>
      Effect.gen(function*() {
        if (!from.projectId) {
          return yield* Effect.fail(invalidRequest())
        }
        const allowed = yield* access.evaluate({
          memberId: assigneeId,
          kind: "project",
          nodeId: from.projectId,
          permission: config.taskAssigneePermission
        }, from.requestId).pipe(Effect.mapError(() => serviceUnavailable()))
        if (!allowed) {
          return yield* Effect.fail(fieldError("assignee_id", "That person can't see this project."))
        }
      })

    const list = (environmentId: string, params: ListParams) =>
      parsePage(params).pipe(
        Effect.flatMap((page) => repo.listByEnvironment(environmentId, page)),
        Effect.withSpan("Tasks.list", { attributes: { "plat5.node_id": environmentId } })
      )

    /** Records `memberId`, the caller's, as the author. */
    const create = (
      environmentId: string,
      memberId: string,
      payload: { title: string; status?: TaskStatus; assignee_id?: string | null },
      from: FrontDoor
    ) =>
      Effect.gen(function*() {
        const assigneeId = payload.assignee_id ?? null
        if (assigneeId !== null) {
          yield* checkAssignee(assigneeId, from)
        }
        const ts = now()
        const task = yield* repo.insert(
          Task.insert.make({
            id: TaskId.make(ulid().toLowerCase()),
            environment_id: environmentId,
            title: payload.title,
            status: payload.status ?? "todo",
            assignee_id: assigneeId,
            created_by: memberId,
            created_at: ts,
            updated_at: ts
          })
        )
        yield* Audit.setDetails({
          task_id: task.id,
          title: task.title,
          status: task.status,
          assignee_id: task.assignee_id
        })
        yield* Audit.setCreated(task.id)
        return task
      }).pipe(
        Effect.withSpan("Tasks.create", { attributes: { "plat5.node_id": environmentId } })
      )

    /** The task, or a 404 when there is none by that id in the environment. */
    const getInEnvironment = (environmentId: string, taskId: string) =>
      Effect.gen(function*() {
        const task = yield* repo.findInEnvironment(environmentId, TaskId.make(taskId))
        if (task === undefined) {
          return yield* Effect.fail(notFound("task", taskId))
        }
        return task
      }).pipe(
        Effect.withSpan("Tasks.getInEnvironment", {
          attributes: { "plat5.node_id": environmentId, task_id: taskId }
        })
      )

    /** `assignee_id` absent leaves the task's as it is; null unassigns. */
    const update = (
      environmentId: string,
      taskId: string,
      payload: { title?: string; status?: TaskStatus; assignee_id?: string | null },
      from: FrontDoor
    ) =>
      Effect.gen(function*() {
        const task = yield* getInEnvironment(environmentId, taskId)
        // Absent and null have nothing to check.
        if (typeof payload.assignee_id === "string") {
          yield* checkAssignee(payload.assignee_id, from)
        }
        const updated = yield* repo.update({
          ...task,
          title: payload.title ?? task.title,
          status: payload.status ?? task.status,
          assignee_id: payload.assignee_id === undefined ? task.assignee_id : payload.assignee_id,
          updated_at: now()
        })
        const changes: Audit.Details = {}
        Audit.changed(changes, "title", task.title, updated.title)
        Audit.changed(changes, "status", task.status, updated.status)
        Audit.changed(changes, "assignee_id", task.assignee_id, updated.assignee_id)
        yield* Audit.setDetails(changes)
        return updated
      }).pipe(
        Effect.withSpan("Tasks.update", {
          attributes: { "plat5.node_id": environmentId, task_id: taskId }
        })
      )

    const remove = (environmentId: string, taskId: string) =>
      Effect.gen(function*() {
        yield* getInEnvironment(environmentId, taskId)
        yield* repo.deleteById(TaskId.make(taskId))
        // No audit details: the route and the task id in its path say what happened.
      }).pipe(
        Effect.withSpan("Tasks.remove", {
          attributes: { "plat5.node_id": environmentId, task_id: taskId }
        })
      )

    return { list, create, getInEnvironment, update, remove } as const
  }),
  dependencies: [TasksRepo.Default, Access.Default, AppConfig.Live]
}) {}
