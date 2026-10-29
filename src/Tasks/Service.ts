import { Effect } from "effect"
import { monotonicFactory } from "ulid"
import { Access } from "../Access.js"
import { AppConfig } from "../AppConfig.js"
import { Task, TaskId, type TaskStatus } from "../domain/Task.js"
import * as Audit from "../plat5/Audit.js"
import { charLength, type Fields, isLowercaseUlid, optionalString, trimSpace } from "../plat5/Body.js"
import { now } from "../plat5/Clock.js"
import { fieldError, invalidRequest, notFound, serviceUnavailable } from "../plat5/Errors.js"
import { type ListParams, parsePage } from "../plat5/Pagination.js"
import { TasksRepo } from "./Repo.js"

// Monotonic, so tasks made in the same millisecond still list in the order they were made.
const ulid = monotonicFactory()

/** The body fields a task write reads: a key that isn't one of these, exactly, is a 422. */
export const TASK_FIELDS = ["title", "status", "assignee_id"] as const

const MAX_TITLE = 255

/** A title, trimmed of white space: required, and at most 255 characters. */
const checkTitle = (raw: string) => {
  const title = trimSpace(raw)
  if (title === "") return Effect.fail(fieldError("title", "Title is required."))
  if (charLength(title) > MAX_TITLE) return Effect.fail(fieldError("title", "Title is too long."))
  return Effect.succeed(title)
}

const STATUSES: ReadonlyArray<string> = ["todo", "in_progress", "done"]

/** A status, exactly as sent. */
const checkStatus = (status: string) =>
  STATUSES.includes(status)
    ? Effect.succeed(status as TaskStatus)
    : Effect.fail(fieldError("status", "Status must be todo, in progress, or done."))

/**
 * `assignee_id`: undefined when absent (leave it), null to unassign, or a member id. Any
 * other value, a string that isn't a lowercase ULID included, is a 422 at assignee_id.
 */
const checkAssigneeId = (value: unknown) =>
  value === undefined || value === null
    ? Effect.succeed(value)
    : typeof value === "string" && isLowercaseUlid(value)
    ? Effect.succeed(value)
    : Effect.fail(fieldError("assignee_id"))

/**
 * What checking an assignee needs from the front door: the environment's project id, from
 * `X-Plat5-Project-Id`, and the request's `X-Request-ID` ("" without one).
 */
export type FrontDoor = {
  readonly projectId: string | undefined
  readonly requestId: string
}

// Every call scopes its reads and writes by the environment id in the path, and checks
// nothing about the caller or the environment: the front door decided who may call, on
// which environment. A write checks its body first (each field's type, then title, status
// and assignee_id), then on an update the task, then the assignee: the project id, then
// identity's answer, before writing.
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
    const create = (environmentId: string, memberId: string, fields: Fields, from: FrontDoor) =>
      Effect.gen(function*() {
        const rawTitle = yield* optionalString(fields, "title")
        const rawStatus = yield* optionalString(fields, "status")
        const title = yield* checkTitle(rawTitle ?? "")
        const status = rawStatus === undefined ? "todo" : yield* checkStatus(rawStatus)
        const assigneeId = (yield* checkAssigneeId(fields.assignee_id)) ?? null
        if (assigneeId !== null) {
          yield* checkAssignee(assigneeId, from)
        }
        const ts = now()
        const task = yield* repo.insert(
          Task.insert.make({
            id: TaskId.make(ulid().toLowerCase()),
            environment_id: environmentId,
            title,
            status,
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

    /**
     * A field absent or null leaves the task's as it is, but for `assignee_id`: null
     * unassigns. `updated_at` moves on every update, even one that changes nothing.
     */
    const update = (environmentId: string, taskId: string, fields: Fields, from: FrontDoor) =>
      Effect.gen(function*() {
        const rawTitle = yield* optionalString(fields, "title")
        const rawStatus = yield* optionalString(fields, "status")
        const title = rawTitle === undefined ? undefined : yield* checkTitle(rawTitle)
        const status = rawStatus === undefined ? undefined : yield* checkStatus(rawStatus)
        const assigneeId = yield* checkAssigneeId(fields.assignee_id)
        const task = yield* getInEnvironment(environmentId, taskId)
        // Absent and null have nothing to check.
        if (typeof assigneeId === "string") {
          yield* checkAssignee(assigneeId, from)
        }
        const updated = yield* repo.updateInEnvironment(Task.make({
          ...task,
          title: title ?? task.title,
          status: status ?? task.status,
          assignee_id: assigneeId === undefined ? task.assignee_id : assigneeId,
          updated_at: now()
        }))
        // Deleted since it was read.
        if (updated === undefined) {
          return yield* Effect.fail(notFound("task", taskId))
        }
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
        const deleted = yield* repo.deleteInEnvironment(environmentId, TaskId.make(taskId))
        // Deleted since it was read.
        if (!deleted) {
          return yield* Effect.fail(notFound("task", taskId))
        }
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
