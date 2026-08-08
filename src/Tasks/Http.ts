import { HttpApiBuilder } from "@effect/platform"
import { Effect, Layer } from "effect"
import { Api } from "../Api.js"
import { CurrentOrg, RequireOrgLive } from "../plat5/Identity.js"
import { Tasks } from "./Service.js"

export const HttpTasksLive = HttpApiBuilder.group(Api, "tasks", (handlers) =>
  Effect.gen(function*() {
    const tasks = yield* Tasks

    return handlers
      .handle("list", ({ path }) =>
        CurrentOrg.pipe(
          Effect.flatMap((org) => tasks.list(org.organizationId, path.project_id)),
          Effect.map((items) => ({ tasks: items }))
        ))
      .handle("create", ({ path, payload }) =>
        CurrentOrg.pipe(
          Effect.flatMap((org) =>
            tasks.create(org.organizationId, org.membershipId, path.project_id, payload)
          )
        ))
      .handle("get", ({ path }) =>
        CurrentOrg.pipe(
          Effect.flatMap((org) =>
            tasks.getInProject(org.organizationId, path.project_id, path.task_id)
          )
        ))
      .handle("update", ({ path, payload }) =>
        CurrentOrg.pipe(
          Effect.flatMap((org) =>
            tasks.update(org.organizationId, path.project_id, path.task_id, payload)
          )
        ))
      .handle("remove", ({ path }) =>
        CurrentOrg.pipe(
          Effect.flatMap((org) =>
            tasks.remove(org.organizationId, path.project_id, path.task_id)
          )
        ))
  })
).pipe(Layer.provide([Tasks.Default, RequireOrgLive]))
