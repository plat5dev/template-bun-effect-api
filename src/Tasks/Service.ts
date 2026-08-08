import { Effect, Option } from "effect"
import { ulid } from "ulid"
import { ProjectId } from "../domain/Project.js"
import { Task, TaskId, type TaskStatus } from "../domain/Task.js"
import { notFound } from "../plat5/Errors.js"
import { Projects } from "../Projects/Service.js"
import { TasksRepo } from "./Repo.js"

const now = () => new Date().toISOString()

export class Tasks extends Effect.Service<Tasks>()("Tasks", {
  effect: Effect.gen(function*() {
    const repo = yield* TasksRepo
    const projects = yield* Projects

    const list = (organizationId: string, projectId: string) =>
      Effect.gen(function*() {
        yield* projects.getInOrg(organizationId, projectId)
        return yield* repo.listByProject(organizationId, ProjectId.make(projectId))
      }).pipe(
        Effect.withSpan("Tasks.list", { attributes: { organizationId, projectId } })
      )

    const create = (
      organizationId: string,
      membershipId: string,
      projectId: string,
      payload: { title: string; status?: TaskStatus }
    ) =>
      Effect.gen(function*() {
        yield* projects.getInOrg(organizationId, projectId)
        return yield* repo.insert(
          Task.insert.make({
            id: TaskId.make(ulid()),
            organization_id: organizationId,
            project_id: ProjectId.make(projectId),
            title: payload.title,
            status: payload.status ?? "todo",
            created_by_membership_id: membershipId,
            created_at: now(),
            updated_at: now()
          })
        )
      }).pipe(
        Effect.withSpan("Tasks.create", { attributes: { organizationId, projectId } })
      )

    const getInProject = (
      organizationId: string,
      projectId: string,
      taskId: string
    ) =>
      Effect.gen(function*() {
        yield* projects.getInOrg(organizationId, projectId)
        const task = yield* repo.findById(TaskId.make(taskId))
        if (
          Option.isNone(task) ||
          task.value.organization_id !== organizationId ||
          task.value.project_id !== projectId
        ) {
          return yield* Effect.fail(notFound("task", taskId))
        }
        return task.value
      }).pipe(
        Effect.withSpan("Tasks.getInProject", {
          attributes: { organizationId, projectId, taskId }
        })
      )

    const update = (
      organizationId: string,
      projectId: string,
      taskId: string,
      payload: { title?: string; status?: TaskStatus }
    ) =>
      Effect.gen(function*() {
        const task = yield* getInProject(organizationId, projectId, taskId)
        return yield* repo.update({
          ...task,
          title: payload.title ?? task.title,
          status: payload.status ?? task.status,
          updated_at: now()
        })
      }).pipe(
        Effect.withSpan("Tasks.update", {
          attributes: { organizationId, projectId, taskId }
        })
      )

    const remove = (organizationId: string, projectId: string, taskId: string) =>
      Effect.gen(function*() {
        yield* getInProject(organizationId, projectId, taskId)
        yield* repo.deleteById(TaskId.make(taskId))
      }).pipe(
        Effect.withSpan("Tasks.remove", {
          attributes: { organizationId, projectId, taskId }
        })
      )

    return { list, create, getInProject, update, remove } as const
  }),
  dependencies: [TasksRepo.Default, Projects.Default]
}) {}
