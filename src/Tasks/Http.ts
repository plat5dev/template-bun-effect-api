import { HttpApiBuilder, HttpServerRequest } from "@effect/platform"
import { Effect, Layer } from "effect"
import { Api } from "../Api.js"
import { readBody } from "../plat5/Body.js"
import { invalidRequest } from "../plat5/Errors.js"
import { MEMBER_HEADER, PROJECT_HEADER, RequireMember } from "./Api.js"
import { type FrontDoor, TASK_FIELDS, Tasks } from "./Service.js"

const RequireMemberLive = Layer.succeed(
  RequireMember,
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!request.headers[MEMBER_HEADER]) {
      return yield* Effect.fail(invalidRequest())
    }
  })
)

const frontDoor = (
  headers: { readonly [PROJECT_HEADER]?: string | undefined },
  request: HttpServerRequest.HttpServerRequest
): FrontDoor => ({
  projectId: headers[PROJECT_HEADER],
  requestId: request.headers["x-request-id"] ?? ""
})

// Writes are raw handlers: they read their own body (src/plat5/Body.ts), so a body that
// isn't JSON, or a field of the wrong type, is the API's 422, never Effect's decode error.
export const HttpTasksLive = HttpApiBuilder.group(Api, "tasks", (handlers) =>
  Effect.gen(function*() {
    const tasks = yield* Tasks

    return handlers
      .handle("list", ({ path, urlParams }) =>
        tasks.list(path.environment_id, urlParams).pipe(
          Effect.map(({ hasMore, items }) => ({ tasks: items, has_more: hasMore }))
        ))
      .handleRaw("create", ({ headers, path, request }) =>
        readBody(TASK_FIELDS).pipe(
          Effect.flatMap((fields) =>
            tasks.create(path.environment_id, headers[MEMBER_HEADER], fields, frontDoor(headers, request))
          )
        ))
      .handle("get", ({ path }) => tasks.getInEnvironment(path.environment_id, path.task_id))
      .handleRaw("update", ({ headers, path, request }) =>
        readBody(TASK_FIELDS).pipe(
          Effect.flatMap((fields) =>
            tasks.update(path.environment_id, path.task_id, fields, frontDoor(headers, request))
          )
        ))
      .handle("remove", ({ path }) => tasks.remove(path.environment_id, path.task_id))
  })
).pipe(Layer.provide(Tasks.Default), Layer.provide(RequireMemberLive))
