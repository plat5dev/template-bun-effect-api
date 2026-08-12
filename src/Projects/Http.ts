import { HttpApiBuilder } from "@effect/platform"
import { Effect, Layer } from "effect"
import { Api } from "../Api.js"
import { CurrentOrg, RequireOrgLive } from "../plat5/Identity.js"
import { Projects } from "./Service.js"

export const HttpProjectsLive = HttpApiBuilder.group(Api, "projects", (handlers) =>
  Effect.gen(function*() {
    const projects = yield* Projects

    return handlers
      .handle("list", () =>
        CurrentOrg.pipe(
          Effect.flatMap((org) => projects.list(org.organizationId)),
          Effect.map((items) => ({ projects: items }))
        ))
      .handle("create", ({ payload }) =>
        CurrentOrg.pipe(
          Effect.flatMap((org) =>
            projects.create(org.organizationId, org.memberId, payload)
          )
        ))
      .handle("get", ({ path }) =>
        CurrentOrg.pipe(
          Effect.flatMap((org) => projects.getInOrg(org.organizationId, path.project_id))
        ))
      .handle("update", ({ path, payload }) =>
        CurrentOrg.pipe(
          Effect.flatMap((org) =>
            projects.update(org.organizationId, path.project_id, payload)
          )
        ))
      .handle("remove", ({ path }) =>
        CurrentOrg.pipe(
          Effect.flatMap((org) => projects.remove(org.organizationId, path.project_id))
        ))
  })
).pipe(Layer.provide([Projects.Default, RequireOrgLive]))
