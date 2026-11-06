import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "@effect/platform"
import { Schema } from "effect"
import { Task, TaskStatus } from "../domain/Task.js"
import {
  InternalError,
  InvalidRequest,
  NotFound,
  ServiceUnavailable,
  ValidationFailed
} from "../plat5/Errors.js"
import { ListParams } from "../plat5/Pagination.js"

/**
 * The caller's member id in the project's tree, from the front door. A create records it as
 * the task's author, and answers 400 without it.
 */
export const MEMBER_HEADER = "x-plat5-member-id"

// The bodies, for the OpenAPI document. The handlers read them (src/plat5/Body.ts) and the
// service checks them, so their answers are the API's own: a body not sent as JSON, or a
// field of the wrong type, is a 422 at `body`.

/** Plat5 ids, and this API's, are ULIDs in lowercase. */
const MemberId = Schema.String.pipe(Schema.pattern(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/))

const AssigneeId = Schema.NullOr(MemberId).annotations({
  description: "A member id in the project's tree who can see the project, or null for none."
})

const Title = Schema.String.annotations({
  description: "Trimmed of white space, then 1 to 255 characters."
})

const TaskCreate = Schema.Struct({
  title: Title,
  status: Schema.optional(TaskStatus),
  assignee_id: Schema.optional(AssigneeId)
})

// A field absent or null leaves the task's as it is, but for assignee_id: null unassigns.
const TaskUpdate = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Title)),
  status: Schema.optional(Schema.NullOr(TaskStatus)),
  assignee_id: Schema.optional(AssigneeId)
})

// RequireMember has checked the member id by the time it's read: without it a create is
// our 400.
const CreateHeaders = Schema.Struct({
  [MEMBER_HEADER]: Schema.String
})

/**
 * Checks a create's `X-Plat5-Member-Id` before its body is read: without it, a 400 whatever
 * the body holds.
 */
export class RequireMember extends HttpApiMiddleware.Tag<RequireMember>()("Tasks/RequireMember", {
  failure: InvalidRequest
}) {}

const ProjectPath = Schema.Struct({
  project_id: Schema.String
})

const TaskPath = Schema.Struct({
  project_id: Schema.String,
  task_id: Schema.String
})

export class TasksApi extends HttpApiGroup.make("tasks")
  .add(
    HttpApiEndpoint.get("list", "/")
      .setPath(ProjectPath)
      .setUrlParams(ListParams)
      .addSuccess(Schema.Struct({ tasks: Schema.Array(Task.json), has_more: Schema.Boolean }))
      .addError(InternalError)
      .addError(ValidationFailed)
  )
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPath(ProjectPath)
      .setHeaders(CreateHeaders)
      .setPayload(TaskCreate)
      .middleware(RequireMember)
      .addSuccess(Task.json, { status: 201 })
      .addError(InvalidRequest)
      .addError(InternalError)
      .addError(ValidationFailed)
      .addError(ServiceUnavailable)
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
      .addError(ServiceUnavailable)
  )
  .add(
    HttpApiEndpoint.del("remove", "/:task_id")
      .setPath(TaskPath)
      .addSuccess(Schema.Void)
      .addError(NotFound)
      .addError(InternalError)
  )
  // A project is a Plat5 node: its id is in the path, from the front door.
  .prefix("/projects/:project_id/tasks")
  .annotate(OpenApi.Title, "Tasks")
  .annotate(OpenApi.Description, "Tasks inside a project")
{}
