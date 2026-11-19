/**
 * Plat5 error envelope, HTTP error schemas, and request decoding middleware.
 */
import { Effect, Layer, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { HttpMethod, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiMiddleware, HttpApiSchema } from "effect/http-api"

export const currentRequestId: Effect.Effect<string | null> = Effect.map(
  Effect.serviceOption(HttpServerRequest.HttpServerRequest),
  Option.match({ onNone: () => null, onSome: (request) => request.headers["x-request-id"] || null })
)

const FieldIssue = Schema.Struct({ path: Schema.String, message: Schema.String })

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {}) {}

export class ValidationFailed extends Schema.TaggedError<ValidationFailed>()("ValidationFailed", {
  fields: Schema.Array(FieldIssue)
}) {
  static field(path: string, message: string): ValidationFailed {
    return new ValidationFailed({ fields: [{ path, message }] })
  }
}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  resource: Schema.String,
  id: Schema.NullOr(Schema.String)
}) {}

export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {}) {}

export class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()("ServiceUnavailable", {}) {}

const Plat5Error = Schema.Union([InvalidRequest, ValidationFailed, NotFound, InternalError, ServiceUnavailable])
type ErrorData = typeof Plat5Error.Encoded

const describe = (e: ErrorData) => {
  switch (e._tag) {
    case "InvalidRequest":
      return { type: "invalid_request_error", code: "INVALID_REQUEST", message: "Malformed request.", details: null }
    case "ValidationFailed":
      return {
        type: "invalid_request_error",
        code: "VALIDATION_ERROR",
        message: e.fields[0]?.message ?? "Validation failed.",
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

export const envelope = (error: ErrorData, requestId: string | null) => {
  const { code, details, message, type } = describe(error)
  return { error: { type, code, message, request_id: requestId, details } }
}

export const errorResponse = (error: ErrorData, status: number) =>
  Effect.map(currentRequestId, (requestId) => HttpServerResponse.jsonUnsafe(envelope(error, requestId), { status }))

const Envelope = Schema.Struct({
  error: Schema.Struct({
    type: Schema.String,
    code: Schema.String,
    message: Schema.String,
    request_id: Schema.NullOr(Schema.String),
    details: Schema.Unknown
  })
})

const answer = <S extends Schema.Top & { readonly Encoded: ErrorData }>(error: S, status: number) =>
  Envelope.pipe(
    Schema.decodeTo(error, {
      decode: SchemaGetter.forbidden(() => "Error envelope is encode-only"),
      encode: SchemaGetter.transformEffect((e: S["Encoded"]) =>
        Effect.map(currentRequestId, (requestId) => envelope(e, requestId))
      )
    }),
    HttpApiSchema.status(status)
  )

export const HttpErrors = {
  InvalidRequest: answer(InvalidRequest, 400),
  ValidationFailed: answer(ValidationFailed, 422),
  NotFound: answer(NotFound, 404),
  InternalError: answer(InternalError, 500),
  ServiceUnavailable: answer(ServiceUnavailable, 503)
}

export const parseOptions = {
  payload: { errors: "all", onExcessProperty: "error" },
  query: { errors: "all" }
} as const

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

const formatPath = (path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined): string =>
  (path ?? []).reduce<string>((out, segment) => {
    const key = typeof segment === "object" ? segment.key : segment
    return typeof key === "number" ? `${out}[${key}]` : out === "" ? String(key) : `${out}.${String(key)}`
  }, "") || "body"

/** Maps Effect's SchemaIssue into Plat5's `VALIDATION_ERROR` field list. */
export const validationFailed = (issue: SchemaIssue.Issue): ValidationFailed => {
  const seen = new Set<string>()
  const fields: Array<{ readonly path: string; readonly message: string }> = []
  for (const item of formatIssues(issue).issues) {
    const path = formatPath(item.path)
    if (seen.has(path)) continue
    seen.add(path)
    fields.push({ path, message: item.message })
  }
  return new ValidationFailed({ fields })
}

export const isJson = (contentType: string | undefined): boolean =>
  contentType?.split(";")[0]?.trim().toLowerCase() === "application/json"

/** Middleware for query-only endpoints (maps schema failures to 422). */
export class Plat5Query extends HttpApiMiddleware.Service<Plat5Query>()("api/plat5/Plat5Query", {
  error: HttpErrors.ValidationFailed
}) {
  static readonly layer = HttpApiMiddleware.layerSchemaErrorTransform(
    Plat5Query,
    (error) => Effect.fail(validationFailed(error.cause.issue))
  )
}

/**
 * Middleware for endpoints with JSON payloads or required headers:
 * non-JSON content-type, missing headers, empty bodies, or bad JSON -> 400;
 * schema validation issues -> 422.
 */
export class Plat5Request extends HttpApiMiddleware.Service<Plat5Request>()("api/plat5/Plat5Request", {
  error: [HttpErrors.InvalidRequest, HttpErrors.ValidationFailed]
}) {
  static readonly layer = Layer.effect(
    this,
    Effect.map(this, (inner) => (httpEffect, options) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (options.endpoint.payload.size > 0 && HttpMethod.hasBody(request.method)) {
          if (!isJson(request.headers["content-type"])) return yield* new InvalidRequest()
        }
        return yield* inner(httpEffect, options)
      })
    )
  ).pipe(
    Layer.provide(
      HttpApiMiddleware.layerSchemaErrorTransform(
        this,
        Effect.fnUntraced(function*(error) {
          if (error.kind === "Headers") return yield* new InvalidRequest()
          if (error.kind === "Payload") {
            const issue = error.cause.issue
            if (issue._tag === "InvalidValue" && issue.annotations?.message === "Expected a valid JSON body") {
              return yield* new InvalidRequest()
            }
            const request = yield* HttpServerRequest.HttpServerRequest
            if ((yield* Effect.orDie(request.text)).trim() === "") {
              return yield* new InvalidRequest()
            }
          }
          return yield* validationFailed(error.cause.issue)
        })
      )
    )
  )
}
