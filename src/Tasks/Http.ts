import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../Api.js"
import { Plat5Request } from "../plat5/Request.js"
import { MEMBER_HEADER } from "./Api.js"
import { Tasks } from "./Service.js"

export const HttpTasksLive = HttpApiBuilder.group(
  Api,
  "tasks",
  Effect.fn(function*(handlers) {
    const tasks = yield* Tasks

    return handlers.handleAll({
      list: ({ params, query }) =>
        tasks.list(params.project_id, query).pipe(
          Effect.map(({ hasMore, items }) => ({ tasks: items, has_more: hasMore }))
        ),
      create: ({ headers, params, payload }) => tasks.create(params.project_id, headers[MEMBER_HEADER], payload),
      get: ({ params }) => tasks.getInProject(params.project_id, params.task_id),
      update: ({ params, payload }) => tasks.update(params.project_id, params.task_id, payload),
      remove: ({ params }) => tasks.remove(params.project_id, params.task_id)
    })
  })
).pipe(Layer.provide([Tasks.layer, Plat5Request.layer]))
