import { HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"

const Field = Schema.Struct({
  path: Schema.String,
  message: Schema.String
})

/**
 * Wire shapes match plat5 docs/reference/errors.md (no framework `_tag`). Each fallback
 * sentence is plat5 docs/reference/error-copy.md's.
 */

/**
 * A 400: the request lacks something the API requires of the front door, such as
 * `X-Plat5-Member-Id` on a create.
 */
export const InvalidRequest = Schema.Struct({
  error: Schema.Struct({
    type: Schema.Literal("invalid_request_error"),
    code: Schema.Literal("INVALID_REQUEST"),
    message: Schema.String,
    request_id: Schema.NullOr(Schema.String),
    details: Schema.Null
  })
}).annotations(HttpApiSchema.annotations({ status: 400 }))
export type InvalidRequest = typeof InvalidRequest.Type

export const ValidationFailed = Schema.Struct({
  error: Schema.Struct({
    type: Schema.Literal("invalid_request_error"),
    code: Schema.Literal("VALIDATION_ERROR"),
    message: Schema.String,
    request_id: Schema.NullOr(Schema.String),
    details: Schema.Struct({
      fields: Schema.Array(Field)
    })
  })
}).annotations(HttpApiSchema.annotations({ status: 422 }))
export type ValidationFailed = typeof ValidationFailed.Type

export const NotFound = Schema.Struct({
  error: Schema.Struct({
    type: Schema.Literal("invalid_request_error"),
    code: Schema.Literal("NOT_FOUND"),
    message: Schema.String,
    request_id: Schema.NullOr(Schema.String),
    details: Schema.Struct({
      resource: Schema.String,
      id: Schema.NullOr(Schema.String)
    })
  })
}).annotations(HttpApiSchema.annotations({ status: 404 }))
export type NotFound = typeof NotFound.Type

export const Conflict = Schema.Struct({
  error: Schema.Struct({
    type: Schema.Literal("invalid_request_error"),
    code: Schema.Literal("CONFLICT"),
    message: Schema.String,
    request_id: Schema.NullOr(Schema.String),
    details: Schema.Struct({
      field: Schema.String,
      value: Schema.String
    })
  })
}).annotations(HttpApiSchema.annotations({ status: 409 }))
export type Conflict = typeof Conflict.Type

export const PayloadTooLarge = Schema.Struct({
  error: Schema.Struct({
    type: Schema.Literal("invalid_request_error"),
    code: Schema.Literal("PAYLOAD_TOO_LARGE"),
    message: Schema.String,
    request_id: Schema.NullOr(Schema.String),
    details: Schema.Struct({
      max_size_bytes: Schema.Number
    })
  })
}).annotations(HttpApiSchema.annotations({ status: 413 }))
export type PayloadTooLarge = typeof PayloadTooLarge.Type

export const InternalError = Schema.Struct({
  error: Schema.Struct({
    type: Schema.Literal("api_error"),
    code: Schema.Literal("INTERNAL_ERROR"),
    message: Schema.String,
    request_id: Schema.NullOr(Schema.String),
    details: Schema.Null
  })
}).annotations(HttpApiSchema.annotations({ status: 500 }))
export type InternalError = typeof InternalError.Type

export const ServiceUnavailable = Schema.Struct({
  error: Schema.Struct({
    type: Schema.Literal("api_error"),
    code: Schema.Literal("SERVICE_UNAVAILABLE"),
    message: Schema.String,
    request_id: Schema.NullOr(Schema.String),
    details: Schema.Null
  })
}).annotations(HttpApiSchema.annotations({ status: 503 }))
export type ServiceUnavailable = typeof ServiceUnavailable.Type

/** The 422 sentence when nothing more specific applies. */
export const FALLBACK_VALIDATION = "That doesn't look right."

export const invalidRequest = (requestId: string | null = null): InvalidRequest => ({
  error: {
    type: "invalid_request_error",
    code: "INVALID_REQUEST",
    message: "Malformed request.",
    request_id: requestId,
    details: null
  }
})

export const validationFailed = (
  fields: ReadonlyArray<{ path: string; message: string }>,
  requestId: string | null = null
): ValidationFailed => ({
  error: {
    type: "invalid_request_error",
    code: "VALIDATION_ERROR",
    message: fields[0]?.message ?? FALLBACK_VALIDATION,
    request_id: requestId,
    details: { fields: [...fields] }
  }
})

/** A 422 for one field. No message is the fallback sentence. */
export const fieldError = (
  path: string,
  message = FALLBACK_VALIDATION,
  requestId: string | null = null
): ValidationFailed => ({
  error: {
    type: "invalid_request_error",
    code: "VALIDATION_ERROR",
    message,
    request_id: requestId,
    details: { fields: [{ path, message }] }
  }
})

export const notFound = (
  resource: string,
  id: string | null,
  requestId: string | null = null
): NotFound => ({
  error: {
    type: "invalid_request_error",
    code: "NOT_FOUND",
    message: "Resource not found.",
    request_id: requestId,
    details: { resource, id }
  }
})

export const conflict = (
  field: string,
  value: string,
  requestId: string | null = null
): Conflict => ({
  error: {
    type: "invalid_request_error",
    code: "CONFLICT",
    message: "That already exists.",
    request_id: requestId,
    details: { field, value }
  }
})

export const payloadTooLarge = (
  maxSizeBytes: number,
  requestId: string | null = null
): PayloadTooLarge => ({
  error: {
    type: "invalid_request_error",
    code: "PAYLOAD_TOO_LARGE",
    message: "Request body is too large.",
    request_id: requestId,
    details: { max_size_bytes: maxSizeBytes }
  }
})

export const internalError = (
  message = "An unexpected error occurred.",
  requestId: string | null = null
): InternalError => ({
  error: {
    type: "api_error",
    code: "INTERNAL_ERROR",
    message,
    request_id: requestId,
    details: null
  }
})

export const serviceUnavailable = (requestId: string | null = null): ServiceUnavailable => ({
  error: {
    type: "api_error",
    code: "SERVICE_UNAVAILABLE",
    message: "Service temporarily unavailable.",
    request_id: requestId,
    details: null
  }
})

export type Plat5Error =
  | InvalidRequest
  | ValidationFailed
  | NotFound
  | Conflict
  | PayloadTooLarge
  | InternalError
  | ServiceUnavailable
