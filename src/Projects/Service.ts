import { Effect, Option } from "effect"
import { ulid } from "ulid"
import { Project, ProjectId } from "../domain/Project.js"
import { notFound } from "../plat5/Errors.js"
import { ProjectsRepo } from "./Repo.js"

const now = () => new Date().toISOString()

export class Projects extends Effect.Service<Projects>()("Projects", {
  effect: Effect.gen(function*() {
    const repo = yield* ProjectsRepo

    const list = (organizationId: string) =>
      repo.listByOrganization(organizationId).pipe(
        Effect.withSpan("Projects.list", { attributes: { organizationId } })
      )

    const create = (
      organizationId: string,
      membershipId: string,
      payload: { name: string; description?: string }
    ) =>
      repo
        .insert(
          Project.insert.make({
            id: ProjectId.make(ulid()),
            organization_id: organizationId,
            name: payload.name,
            description: payload.description ?? "",
            created_by_membership_id: membershipId,
            created_at: now(),
            updated_at: now()
          })
        )
        .pipe(Effect.withSpan("Projects.create", { attributes: { organizationId } }))

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
        return yield* repo.update({
          ...project,
          name: payload.name ?? project.name,
          description: payload.description ?? project.description,
          updated_at: now()
        })
      }).pipe(
        Effect.withSpan("Projects.update", {
          attributes: { organizationId, projectId }
        })
      )

    const remove = (organizationId: string, projectId: string) =>
      Effect.gen(function*() {
        yield* getInOrg(organizationId, projectId)
        yield* repo.deleteById(ProjectId.make(projectId))
      }).pipe(
        Effect.withSpan("Projects.remove", {
          attributes: { organizationId, projectId }
        })
      )

    return { list, create, getInOrg, update, remove } as const
  }),
  dependencies: [ProjectsRepo.Default]
}) {}
