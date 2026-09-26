import { HttpApiBuilder } from "@effect/platform"
import { Effect, Layer } from "effect"
import { Api } from "../Api.js"
import { Projects } from "./Service.js"

export const HttpProjectsLive = HttpApiBuilder.group(Api, "projects", (handlers) =>
  Effect.gen(function*() {
    const projects = yield* Projects

    return handlers
      .handle("list", ({ path }) =>
        projects.list(path.organization_id).pipe(
          Effect.map((items) => ({ projects: items }))
        ))
      .handle("create", ({ path, payload }) =>
        projects.create(path.organization_id, path.member_id, payload))
      .handle("get", ({ path }) => projects.getInOrg(path.organization_id, path.project_id))
      .handle("update", ({ path, payload }) =>
        projects.update(path.organization_id, path.project_id, payload))
      .handle("remove", ({ path }) => projects.remove(path.organization_id, path.project_id))
  })
).pipe(Layer.provide(Projects.Default))
