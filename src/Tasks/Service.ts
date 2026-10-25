import { Effect } from "effect"
import { ulid } from "ulid"
import { Task, TaskId, type TaskStatus } from "../domain/Task.js"
import * as Audit from "../plat5/Audit.js"
import { invalidRequest, notFound } from "../plat5/Errors.js"
import { type ListParams, parsePage } from "../plat5/Pagination.js"
import { TasksRepo } from "./Repo.js"

const now = () => new Date().toISOString()

// Every call scopes its lookups by the project id in the path, and checks nothing about
// the caller or the project: the front door decided who may call, on which project.
export class Tasks extends Effect.Service<Tasks>()("Tasks", {
  effect: Effect.gen(function*() {
    const repo = yield* TasksRepo

    const list = (projectId: string, params: ListParams) =>
      parsePage(params).pipe(
        Effect.flatMap((page) => repo.listByProject(projectId, page)),
        Effect.withSpan("Tasks.list", { attributes: { "plat5.node_id": projectId } })
      )

    /** Records `memberId`, the caller's, as the author. Without one it's a 400. */
    const create = (
      projectId: string,
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
            project_id: projectId,
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
        Effect.withSpan("Tasks.create", { attributes: { "plat5.node_id": projectId } })
      )

    /** The task, or a 404 when there is none by that id in the project. */
    const getInProject = (projectId: string, taskId: string) =>
      Effect.gen(function*() {
        const task = yield* repo.findInProject(projectId, TaskId.make(taskId))
        if (task === undefined) {
          return yield* Effect.fail(notFound("task", taskId))
        }
        return task
      }).pipe(
        Effect.withSpan("Tasks.getInProject", {
          attributes: { "plat5.node_id": projectId, task_id: taskId }
        })
      )

    const update = (
      projectId: string,
      taskId: string,
      payload: { title?: string; status?: TaskStatus }
    ) =>
      Effect.gen(function*() {
        const task = yield* getInProject(projectId, taskId)
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
          attributes: { "plat5.node_id": projectId, task_id: taskId }
        })
      )

    const remove = (projectId: string, taskId: string) =>
      Effect.gen(function*() {
        yield* getInProject(projectId, taskId)
        yield* repo.deleteById(TaskId.make(taskId))
        // No audit details: the route and the task id in its path say what happened.
      }).pipe(
        Effect.withSpan("Tasks.remove", {
          attributes: { "plat5.node_id": projectId, task_id: taskId }
        })
      )

    return { list, create, getInProject, update, remove } as const
  }),
  dependencies: [TasksRepo.Default]
}) {}
