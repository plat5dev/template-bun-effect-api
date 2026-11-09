/**
 * Plat5's errors (plat5 docs/reference/errors.md), and how the API answers with them.
 *
 * A service fails with one of the classes here: what went wrong, in Plat5's words, and
 * nothing about HTTP. `HttpErrors` are the same errors at the API's edge: each one's
 * endpoint answer, Plat5's envelope with its status. The envelope's `request_id` is the
 * request's `X-Request-ID`, filled in as the error is written, so nothing has to carry it.
 * Each sentence is plat5 docs/reference/error-copy.md's.
 */
import { Effect, Schema, SchemaGetter } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiSchema } from "effect/http-api"
import { currentRequestId } from "./RequestId.js"

/** The 422 sentence when nothing more specific applies. */
export const FALLBACK_VALIDATION = "That doesn't look right."

const FieldIssue = Schema.Struct({ path: Schema.String, message: Schema.String })

/** A 400: the request is malformed before its values are read. */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {}) {}

/** A 422: the fields that are wrong, each with its sentence. */
export class ValidationFailed extends Schema.TaggedError<ValidationFailed>()("ValidationFailed", {
  fields: Schema.Array(FieldIssue)
}) {
  /** One field wrong. No sentence is the fallback one. */
  static field(path: string, message = FALLBACK_VALIDATION): ValidationFailed {
    return new ValidationFailed({ fields: [{ path, message }] })
  }
}

/** A 404: no `resource` by that id, or none the caller can reach. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  resource: Schema.String,
  id: Schema.NullOr(Schema.String)
}) {}

/** A 500. Its message is always the fallback sentence: never a framework's or a library's. */
export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {}) {}

/** A 503: a dependency, identity say, didn't answer. */
export class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()("ServiceUnavailable", {}) {}

const Plat5Error = Schema.Union([InvalidRequest, ValidationFailed, NotFound, InternalError, ServiceUnavailable])
export type Plat5Error = typeof Plat5Error.Type

/** An error's data, as its schema encodes it: its tag and its fields. */
type ErrorData = typeof Plat5Error.Encoded

/** Where each error sits in the envelope. */
const describe = (e: ErrorData) => {
  switch (e._tag) {
    case "InvalidRequest":
      return { type: "invalid_request_error", code: "INVALID_REQUEST", message: "Malformed request.", details: null }
    case "ValidationFailed":
      return {
        type: "invalid_request_error",
        code: "VALIDATION_ERROR",
        message: e.fields[0]?.message ?? FALLBACK_VALIDATION,
        details: { fields: e.fields }
      }
    case "NotFound":
      return {
        type: "invalid_request_error",
        code: "NOT_FOUND",
        message: "Resource not found.",
        details: { resource: e.resource, id: e.id }
      }
    case "InternalError":
      return { type: "api_error", code: "INTERNAL_ERROR", message: "An unexpected error occurred.", details: null }
    case "ServiceUnavailable":
      return { type: "api_error", code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable.", details: null }
  }
}

/** The error as the API answers with it: Plat5's envelope, no framework `_tag`. */
export const envelope = (error: ErrorData, requestId: string | null) => {
  const { code, details, message, type } = describe(error)
  return { error: { type, code, message, request_id: requestId, details } }
}

/** `error` as a response with `status`, for a route outside the API's endpoints. */
export const errorResponse = (error: ErrorData, status: number) =>
  Effect.map(currentRequestId, (requestId) => HttpServerResponse.jsonUnsafe(envelope(error, requestId), { status }))

/** The envelope's schema, for the OpenAPI document. */
const Envelope = Schema.Struct({
  error: Schema.Struct({
    type: Schema.String,
    code: Schema.String,
    message: Schema.String,
    request_id: Schema.NullOr(Schema.String),
    details: Schema.Unknown
  })
})

/** An error's endpoint answer: the envelope with `status`, written with the request's id. */
const answer = <S extends Schema.Top & { readonly Encoded: ErrorData }>(error: S, status: number) =>
  Envelope.pipe(
    Schema.decodeTo(error, {
      // The API writes errors; it never reads one.
      decode: SchemaGetter.forbidden(() => "an error envelope isn't read back"),
      encode: SchemaGetter.transformEffect((e: S["Encoded"]) =>
        Effect.map(currentRequestId, (requestId) => envelope(e, requestId))
      )
    }),
    HttpApiSchema.status(status)
  )

/** Plat5's errors as endpoints answer with them: list each one an endpoint can answer. */
export const HttpErrors = {
  InvalidRequest: answer(InvalidRequest, 400),
  ValidationFailed: answer(ValidationFailed, 422),
  NotFound: answer(NotFound, 404),
  InternalError: answer(InternalError, 500),
  ServiceUnavailable: answer(ServiceUnavailable, 503)
}
