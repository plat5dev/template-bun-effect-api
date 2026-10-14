import { HttpApiBuilder } from "@effect/platform"
import { Effect, Layer } from "effect"
import { Api } from "../Api.js"
import { Projects } from "./Service.js"

export const HttpProjectsLive = HttpApiBuilder.group(Api, "projects", (handlers) =>
  Effect.gen(function*() {
    const projects = yield* Projects

    return handlers
      .handle("list", ({ path, urlParams }) =>
        projects.list(path.organization_id, urlParams).pipe(
          Effect.map(({ hasMore, items }) => ({ projects: items, has_more: hasMore }))
        ))
      .handle("create", ({ path, payload }) =>
        projects.create(path.organization_id, payload))
      .handle("get", ({ path }) => projects.getInOrg(path.organization_id, path.project_id))
      .handle("update", ({ path, payload }) =>
        projects.update(path.organization_id, path.project_id, payload))
      .handle("remove", ({ path }) => projects.remove(path.organization_id, path.project_id))
  })
).pipe(Layer.provide(Projects.Default))
