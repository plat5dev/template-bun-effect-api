import { HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"

const Field = Schema.Struct({
  path: Schema.String,
  message: Schema.String
})

/** Wire shape matches plat5/docs/api-errors.md (no framework `_tag`). */
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
      id: Schema.String
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

export const validationFailed = (
  fields: ReadonlyArray<{ path: string; message: string }>,
  requestId: string | null = null
): ValidationFailed => ({
  error: {
    type: "invalid_request_error",
    code: "VALIDATION_ERROR",
    message: "Request validation failed",
    request_id: requestId,
    details: { fields: [...fields] }
  }
})

/** The 422 sentence when nothing more specific applies. */
export const FALLBACK_VALIDATION = "That doesn't look right."

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
  id: string,
  requestId: string | null = null
): NotFound => ({
  error: {
    type: "invalid_request_error",
    code: "NOT_FOUND",
    message: "Resource not found",
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
    message: "Resource already exists",
    request_id: requestId,
    details: { field, value }
  }
})

export const internalError = (
  message = "An unexpected error occurred",
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
    message: "Service temporarily unavailable",
    request_id: requestId,
    details: null
  }
})

export type Plat5Error =
  | ValidationFailed
  | NotFound
  | Conflict
  | InternalError
  | ServiceUnavailable
