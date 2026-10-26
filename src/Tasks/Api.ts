import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform"
import { Schema } from "effect"
import { Task, TaskStatus } from "../domain/Task.js"
import { InternalError, InvalidRequest, NotFound, ValidationFailed } from "../plat5/Errors.js"
import { ListParams } from "../plat5/Pagination.js"

/**
 * The caller's member id in the environment's tree, from the front door. A create records
 * it as the task's author, and answers 400 without it.
 */
export const MEMBER_HEADER = "x-plat5-member-id"

const TaskCreate = Schema.Struct({
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  status: Schema.optional(TaskStatus)
})

const TaskUpdate = Schema.Struct({
  title: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255))),
  status: Schema.optional(TaskStatus)
})

// Optional here, so a create without it is our 400, not a decode error.
const MemberHeaders = Schema.Struct({
  [MEMBER_HEADER]: Schema.optional(Schema.String)
})

const EnvironmentPath = Schema.Struct({
  environment_id: Schema.String
})

const TaskPath = Schema.Struct({
  environment_id: Schema.String,
  task_id: Schema.String
})

export class TasksApi extends HttpApiGroup.make("tasks")
  .add(
    HttpApiEndpoint.get("list", "/")
      .setPath(EnvironmentPath)
      .setUrlParams(ListParams)
      .addSuccess(Schema.Struct({ tasks: Schema.Array(Task.json), has_more: Schema.Boolean }))
      .addError(InternalError)
      .addError(ValidationFailed)
  )
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPath(EnvironmentPath)
      .setHeaders(MemberHeaders)
      .setPayload(TaskCreate)
      .addSuccess(Task.json, { status: 201 })
      .addError(InvalidRequest)
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
  // An environment is a Plat5 node: its id is in the path, from the front door.
  .prefix("/environments/:environment_id/tasks")
  .annotate(OpenApi.Title, "Tasks")
  .annotate(OpenApi.Description, "Tasks inside an environment")
{}
