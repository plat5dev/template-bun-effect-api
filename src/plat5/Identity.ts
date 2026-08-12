import { Headers, HttpApiMiddleware, HttpServerRequest } from "@effect/platform"
import { Context, Effect, Layer, Option } from "effect"
import { InternalError, internalError } from "./Errors.js"

export class CurrentUser extends Context.Tag("plat5/CurrentUser")<
  CurrentUser,
  { readonly userId: string }
>() {}

export class CurrentOrg extends Context.Tag("plat5/CurrentOrg")<
  CurrentOrg,
  {
    readonly organizationId: string
    readonly memberId: string
  }
>() {}

/** Missing expected gateway identity headers → platform bug (500), never 401. */
export class RequireUser extends HttpApiMiddleware.Tag<RequireUser>()("plat5/RequireUser", {
  failure: InternalError,
  provides: CurrentUser
}) {}

export class RequireOrg extends HttpApiMiddleware.Tag<RequireOrg>()("plat5/RequireOrg", {
  failure: InternalError,
  provides: CurrentOrg
}) {}

export const RequireUserLive = Layer.succeed(
  RequireUser,
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const userId = Headers.get(request.headers, "x-user-id")
    const requestId = Option.getOrNull(Headers.get(request.headers, "x-request-id"))

    if (Option.isNone(userId)) {
      return yield* Effect.fail(
        internalError("Missing expected identity header X-User-Id", requestId)
      )
    }

    return { userId: userId.value }
  })
)

export const RequireOrgLive = Layer.succeed(
  RequireOrg,
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const organizationId = Headers.get(request.headers, "x-organization-id")
    const memberId = Headers.get(request.headers, "x-member-id")
    const requestId = Option.getOrNull(Headers.get(request.headers, "x-request-id"))

    if (Option.isNone(organizationId) || Option.isNone(memberId)) {
      return yield* Effect.fail(
        internalError(
          "Missing expected identity headers X-Organization-Id and/or X-Member-Id",
          requestId
        )
      )
    }

    return {
      organizationId: organizationId.value,
      memberId: memberId.value
    }
  })
)
