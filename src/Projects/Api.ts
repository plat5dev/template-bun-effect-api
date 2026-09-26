import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform"
import { Schema } from "effect"
import { Project } from "../domain/Project.js"
import { InternalError, NotFound, ValidationFailed } from "../plat5/Errors.js"

const ProjectCreate = Schema.Struct({
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  description: Schema.optional(Schema.String.pipe(Schema.maxLength(2000)))
})

const ProjectUpdate = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255))),
  description: Schema.optional(Schema.String.pipe(Schema.maxLength(2000)))
})

const MemberPath = Schema.Struct({
  organization_id: Schema.String,
  member_id: Schema.String
})

const MemberProjectPath = Schema.Struct({
  organization_id: Schema.String,
  member_id: Schema.String,
  project_id: Schema.String
})

export class ProjectsApi extends HttpApiGroup.make("projects")
  .add(
    HttpApiEndpoint.get("list", "/")
      .setPath(MemberPath)
      .addSuccess(Schema.Struct({ projects: Schema.Array(Project.json) }))
      .addError(InternalError)
  )
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPath(MemberPath)
      .setPayload(ProjectCreate)
      .addSuccess(Project.json, { status: 201 })
      .addError(InternalError)
      .addError(ValidationFailed)
  )
  .add(
    HttpApiEndpoint.get("get", "/:project_id")
      .setPath(MemberProjectPath)
      .addSuccess(Project.json)
      .addError(NotFound)
      .addError(InternalError)
  )
  .add(
    HttpApiEndpoint.patch("update", "/:project_id")
      .setPath(MemberProjectPath)
      .setPayload(ProjectUpdate)
      .addSuccess(Project.json)
      .addError(NotFound)
      .addError(InternalError)
      .addError(ValidationFailed)
  )
  .add(
    HttpApiEndpoint.del("remove", "/:project_id")
      .setPath(MemberProjectPath)
      .addSuccess(Schema.Void)
      .addError(NotFound)
      .addError(InternalError)
  )
  .prefix("/organizations/:organization_id/members/:member_id/projects")
  .annotate(OpenApi.Title, "Projects")
  .annotate(OpenApi.Description, "Member-scoped projects")
{}
