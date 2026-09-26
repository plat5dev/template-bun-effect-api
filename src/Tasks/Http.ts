import { HttpApiBuilder } from "@effect/platform"
import { Effect, Layer } from "effect"
import { Api } from "../Api.js"
import { Tasks } from "./Service.js"

export const HttpTasksLive = HttpApiBuilder.group(Api, "tasks", (handlers) =>
  Effect.gen(function*() {
    const tasks = yield* Tasks

    return handlers
      .handle("list", ({ path }) =>
        tasks.list(path.organization_id, path.project_id).pipe(
          Effect.map((items) => ({ tasks: items }))
        ))
      .handle("create", ({ path, payload }) =>
        tasks.create(path.organization_id, path.member_id, path.project_id, payload))
      .handle("get", ({ path }) =>
        tasks.getInProject(path.organization_id, path.project_id, path.task_id))
      .handle("update", ({ path, payload }) =>
        tasks.update(path.organization_id, path.project_id, path.task_id, payload))
      .handle("remove", ({ path }) =>
        tasks.remove(path.organization_id, path.project_id, path.task_id))
  })
).pipe(Layer.provide(Tasks.Default))
