import { Effect, Option } from "effect"
import { ulid } from "ulid"
import { Project, ProjectId } from "../domain/Project.js"
import * as Audit from "../plat5/Audit.js"
import { notFound } from "../plat5/Errors.js"
import { type ListParams, parsePage } from "../plat5/Pagination.js"
import { ProjectsRepo } from "./Repo.js"

const now = () => new Date().toISOString()

export class Projects extends Effect.Service<Projects>()("Projects", {
  effect: Effect.gen(function*() {
    const repo = yield* ProjectsRepo

    const list = (organizationId: string, params: ListParams) =>
      parsePage(params).pipe(
        Effect.flatMap((page) => repo.listByOrganization(organizationId, page)),
        Effect.withSpan("Projects.list", { attributes: { organizationId } })
      )

    const create = (
      organizationId: string,
      payload: { name: string; description?: string }
    ) =>
      Effect.gen(function*() {
        const project = yield* repo.insert(
          Project.insert.make({
            id: ProjectId.make(ulid()),
            organization_id: organizationId,
            name: payload.name,
            description: payload.description ?? "",
            created_at: now(),
            updated_at: now()
          })
        )
        yield* Audit.setDetails({ project_id: project.id, name: project.name })
        yield* Audit.setCreated(project.id)
        return project
      }).pipe(Effect.withSpan("Projects.create", { attributes: { organizationId } }))

    const getInOrg = (organizationId: string, projectId: string) =>
      Effect.gen(function*() {
        const project = yield* repo.findById(ProjectId.make(projectId))
        if (Option.isNone(project) || project.value.organization_id !== organizationId) {
          return yield* Effect.fail(notFound("project", projectId))
        }
        return project.value
      }).pipe(
        Effect.withSpan("Projects.getInOrg", {
          attributes: { organizationId, projectId }
        })
      )

    const update = (
      organizationId: string,
      projectId: string,
      payload: { name?: string; description?: string }
    ) =>
      Effect.gen(function*() {
        const project = yield* getInOrg(organizationId, projectId)
        const updated = yield* repo.update({
          ...project,
          name: payload.name ?? project.name,
          description: payload.description ?? project.description,
          updated_at: now()
        })
        const changes: Audit.Details = {}
        Audit.changed(changes, "name", project.name, updated.name)
        Audit.changed(changes, "description", project.description, updated.description)
        yield* Audit.setDetails(changes)
        return updated
      }).pipe(
        Effect.withSpan("Projects.update", {
          attributes: { organizationId, projectId }
        })
      )

    const remove = (organizationId: string, projectId: string) =>
      Effect.gen(function*() {
        yield* getInOrg(organizationId, projectId)
        yield* repo.deleteById(ProjectId.make(projectId))
        // No audit details: the route and the project id in its path say what happened.
      }).pipe(
        Effect.withSpan("Projects.remove", {
          attributes: { organizationId, projectId }
        })
      )

    return { list, create, getInOrg, update, remove } as const
  }),
  dependencies: [ProjectsRepo.Default]
}) {}
