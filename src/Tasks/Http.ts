import { HttpApiBuilder } from "@effect/platform"
import { Effect, Layer } from "effect"
import { Api } from "../Api.js"
import { MEMBER_HEADER } from "./Api.js"
import { Tasks } from "./Service.js"

export const HttpTasksLive = HttpApiBuilder.group(Api, "tasks", (handlers) =>
  Effect.gen(function*() {
    const tasks = yield* Tasks

    return handlers
      .handle("list", ({ path, urlParams }) =>
        tasks.list(path.project_id, urlParams).pipe(
          Effect.map(({ hasMore, items }) => ({ tasks: items, has_more: hasMore }))
        ))
      .handle("create", ({ headers, path, payload }) =>
        tasks.create(path.project_id, headers[MEMBER_HEADER], payload))
      .handle("get", ({ path }) => tasks.getInProject(path.project_id, path.task_id))
      .handle("update", ({ path, payload }) =>
        tasks.update(path.project_id, path.task_id, payload))
      .handle("remove", ({ path }) => tasks.remove(path.project_id, path.task_id))
  })
).pipe(Layer.provide(Tasks.Default))
