import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { Task, TaskCreate, TaskUpdate } from "../domain/Task.js"
import { HttpErrors } from "../plat5/Errors.js"
import { ListParams } from "../plat5/Pagination.js"
import { Plat5Request } from "../plat5/Request.js"

/**
 * The caller's member id in the project's tree, from the front door. A create records it as
 * the task's author, and answers 400 without it, whatever its body holds.
 */
export const MEMBER_HEADER = "x-plat5-member-id"

const CreateHeaders = { [MEMBER_HEADER]: Schema.NonEmptyString }

/** A task as the API answers with it: the `Task` component of the OpenAPI document. */
const TaskJson = Task.json.annotate({ identifier: "Task" })

const ProjectPath = { project_id: Schema.String }

const TaskPath = { project_id: Schema.String, task_id: Schema.String }

export class TasksApi extends HttpApiGroup.make("tasks")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: ProjectPath,
      query: ListParams,
      success: Schema.Struct({ tasks: Schema.Array(TaskJson), has_more: Schema.Boolean }),
    }),
    HttpApiEndpoint.post("create", "/", {
      params: ProjectPath,
      headers: CreateHeaders,
      payload: TaskCreate,
      success: TaskJson.pipe(HttpApiSchema.status(201)),
      error: [HttpErrors.ValidationFailed, HttpErrors.ServiceUnavailable]
    }),
    HttpApiEndpoint.get("get", "/:task_id", {
      params: TaskPath,
      success: TaskJson,
      error: HttpErrors.NotFound
    }),
    HttpApiEndpoint.patch("update", "/:task_id", {
      params: TaskPath,
      payload: TaskUpdate,
      success: TaskJson,
      error: [HttpErrors.NotFound, HttpErrors.ValidationFailed, HttpErrors.ServiceUnavailable]
    }),
    HttpApiEndpoint.delete("remove", "/:task_id", {
      params: TaskPath,
      error: HttpErrors.NotFound
    })
  )
  // A project is a Plat5 node: its id is in the path, from the front door.
  // Every request read, and every defect answered, the Plat5 way (src/plat5/Request.ts).
  .middleware(Plat5Request)
  .prefix("/projects/:project_id/tasks")
  .annotateMerge(OpenApi.annotations({ title: "Tasks", description: "Tasks inside a project" }))
{}
