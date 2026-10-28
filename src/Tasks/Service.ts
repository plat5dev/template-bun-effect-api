import { Effect } from "effect"
import { monotonicFactory } from "ulid"
import { Task, TaskId, type TaskStatus } from "../domain/Task.js"
import * as Audit from "../plat5/Audit.js"
import { invalidRequest, notFound } from "../plat5/Errors.js"
import { type ListParams, parsePage } from "../plat5/Pagination.js"
import { TasksRepo } from "./Repo.js"

const now = () => new Date().toISOString()

// Monotonic, so tasks made in the same millisecond still list in the order they were made.
const ulid = monotonicFactory()

// Every call scopes its lookups by the environment id in the path, and checks nothing
// about the caller or the environment: the front door decided who may call, on which
// environment.
export class Tasks extends Effect.Service<Tasks>()("Tasks", {
  effect: Effect.gen(function*() {
    const repo = yield* TasksRepo

    const list = (environmentId: string, params: ListParams) =>
      parsePage(params).pipe(
        Effect.flatMap((page) => repo.listByEnvironment(environmentId, page)),
        Effect.withSpan("Tasks.list", { attributes: { "plat5.node_id": environmentId } })
      )

    /** Records `memberId`, the caller's, as the author. Without one it's a 400. */
    const create = (
      environmentId: string,
      memberId: string | undefined,
      payload: { title: string; status?: TaskStatus }
    ) =>
      Effect.gen(function*() {
        if (!memberId) {
          return yield* Effect.fail(invalidRequest())
        }
        const ts = now()
        const task = yield* repo.insert(
          Task.insert.make({
            id: TaskId.make(ulid().toLowerCase()),
            environment_id: environmentId,
            title: payload.title,
            status: payload.status ?? "todo",
            created_by: memberId,
            created_at: ts,
            updated_at: ts
          })
        )
        yield* Audit.setDetails({ task_id: task.id, title: task.title, status: task.status })
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

    const update = (
      environmentId: string,
      taskId: string,
      payload: { title?: string; status?: TaskStatus }
    ) =>
      Effect.gen(function*() {
        const task = yield* getInEnvironment(environmentId, taskId)
        const updated = yield* repo.update({
          ...task,
          title: payload.title ?? task.title,
          status: payload.status ?? task.status,
          updated_at: now()
        })
        const changes: Audit.Details = {}
        Audit.changed(changes, "title", task.title, updated.title)
        Audit.changed(changes, "status", task.status, updated.status)
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
  dependencies: [TasksRepo.Default]
}) {}
