import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform"
import { Schema } from "effect"
import { Task, TaskStatus } from "../domain/Task.js"
import { InternalError, NotFound, ValidationFailed } from "../plat5/Errors.js"
import { RequireOrg } from "../plat5/Identity.js"

const TaskCreate = Schema.Struct({
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  status: Schema.optional(TaskStatus)
})

const TaskUpdate = Schema.Struct({
  title: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255))),
  status: Schema.optional(TaskStatus)
})

const ProjectPath = Schema.Struct({
  organization_id: Schema.String,
  project_id: Schema.String
})

const TaskPath = Schema.Struct({
  organization_id: Schema.String,
  project_id: Schema.String,
  task_id: Schema.String
})

export class TasksApi extends HttpApiGroup.make("tasks")
  .add(
    HttpApiEndpoint.get("list", "/")
      .setPath(ProjectPath)
      .addSuccess(Schema.Struct({ tasks: Schema.Array(Task.json) }))
      .addError(NotFound)
      .addError(InternalError)
  )
  .add(
      HttpApiEndpoint.post("create", "/")
      .setPath(ProjectPath)
      .setPayload(TaskCreate)
      .addSuccess(Task.json, { status: 201 })
      .addError(NotFound)
      .addError(InternalError)
      .addError(ValidationFailed)
  )
  .add(
    HttpApiEndpoint.get("get", "/:task_id")
      .setPath(TaskPath)
      .addSuccess(Task.json)
      .addError(NotFound)
      .addError(InternalError)
  )
  .add(
    HttpApiEndpoint.patch("update", "/:task_id")
      .setPath(TaskPath)
      .setPayload(TaskUpdate)
      .addSuccess(Task.json)
      .addError(NotFound)
      .addError(InternalError)
      .addError(ValidationFailed)
  )
  .add(
    HttpApiEndpoint.del("remove", "/:task_id")
      .setPath(TaskPath)
      .addSuccess(Schema.Void)
      .addError(NotFound)
      .addError(InternalError)
  )
  .middleware(RequireOrg)
  .prefix("/api/organizations/:organization_id/projects/:project_id/tasks")
  .annotate(OpenApi.Title, "Tasks")
  .annotate(OpenApi.Description, "Project-scoped tasks (organization scope)")
{}
