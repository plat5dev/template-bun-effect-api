/**
 * How an endpoint reads its request, the Plat5 way (plat5 docs/reference/errors.md#which-status).
 *
 * An endpoint's params, query, headers and body are its schemas: Effect decodes them, keys
 * matched exactly, a body's unknown keys refused. `Plat5Request`, on each endpoint that
 * reads one, answers what doesn't decode in Plat5's words:
 *
 * - A request malformed before its values are read is a 400 `INVALID_REQUEST`: a body not
 *   sent as `application/json`, an empty body, a body that isn't JSON, or a missing header
 *   the API requires of the front door.
 * - Values that are wrong are a 422 `VALIDATION_ERROR`, a field per issue, each at its path
 *   (`title`, `address.street`, `tags[0].name`; the body itself is `body`) with the sentence
 *   its schema gives (its `message`, or for an absent key its `messageMissingKey`), else the
 *   fallback one. A field with more than one issue is named once, for its first. A body with an unknown key is refused for those alone, before its values are
 *   checked: each one `<path> isn't a field.`.
 */
import { Effect, Layer, type SchemaAST, type SchemaIssue } from "effect"
import { HttpMethod, HttpServerRequest } from "effect/http"
import { HttpApiError, HttpApiMiddleware } from "effect/http-api"
import { FALLBACK_VALIDATION, HttpErrors, InternalError, InvalidRequest, ValidationFailed } from "./Errors.js"

/** Every schema's parse options: all the issues, and a body's unknown keys among them. */
export const parseOptions = {
  payload: { errors: "all", onExcessProperty: "error" },
  query: { errors: "all" }
} as const

type Field = { readonly path: string; readonly message: string }

const annotated = (annotations: unknown): string | undefined => {
  const message = (annotations as { readonly message?: unknown } | undefined)?.message
  return typeof message === "string" ? message : undefined
}

/** For a union (a nullable field, say): the first sentence one of its members gives. */
const unionMessage = (ast: SchemaAST.AST): string | undefined => {
  if (ast._tag !== "Union") return undefined
  for (const member of ast.types) {
    const message = annotated(member.annotations) ?? unionMessage(member)
    if (message !== undefined) return message
  }
  return undefined
}

/** The sentence a schema gives for `issue`, if it gives one. */
const messageOf = (issue: SchemaIssue.Issue): string | undefined => {
  switch (issue._tag) {
    case "Filter":
      return annotated(issue.filter.annotations) ?? messageOf(issue.issue)
    case "MissingKey": {
      const message = issue.annotations?.messageMissingKey
      return typeof message === "string" ? message : undefined
    }
    case "InvalidType":
      return annotated(issue.ast.annotations) ?? unionMessage(issue.ast)
    case "InvalidValue":
    case "Forbidden":
      return annotated(issue.annotations)
    case "Encoding":
      return annotated(issue.ast.annotations) ?? messageOf(issue.issue)
    case "Pointer":
      return messageOf(issue.issue)
    case "AnyOf":
    case "Composite": {
      const own = annotated(issue.ast.annotations)
      if (own !== undefined) return own
      for (const inner of issue.issues) {
        const message = messageOf(inner)
        if (message !== undefined) return message
      }
      return unionMessage(issue.ast)
    }
    default:
      return undefined
  }
}

const pathOf = (path: ReadonlyArray<PropertyKey>): string =>
  path.reduce<string>(
    (out, key) => (typeof key === "number" ? `${out}[${key}]` : out === "" ? String(key) : `${out}.${String(key)}`),
    ""
  )

const collect = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>,
  out: { known: Array<Field>; unknown: Array<Field> }
): void => {
  switch (issue._tag) {
    case "Pointer":
      return collect(issue.issue, [...path, ...issue.path], out)
    case "Composite":
      for (const inner of issue.issues) collect(inner, path, out)
      return
    case "AnyOf":
      // A union with one member (as HttpApi wraps a body's schema) is that member.
      if (issue.issues.length === 1) return collect(issue.issues[0]!, path, out)
      break
    case "UnexpectedKey": {
      const at = pathOf(path)
      out.unknown.push({ path: at, message: `${at} isn't a field.` })
      return
    }
  }
  out.known.push({ path: pathOf(path) || "body", message: messageOf(issue) ?? FALLBACK_VALIDATION })
}

/** `fields`, each path once: its first issue. */
const firstPerPath = (fields: ReadonlyArray<Field>): Array<Field> => {
  const seen = new Set<string>()
  return fields.filter((field) => !seen.has(field.path) && seen.add(field.path))
}

/**
 * The 422 for a schema's issue: its unknown keys if it has any, else each wrong value. A
 * field is named once, with its first issue's sentence.
 */
export const validationFailed = (issue: SchemaIssue.Issue): ValidationFailed => {
  const out = { known: [] as Array<Field>, unknown: [] as Array<Field> }
  collect(issue, [], out)
  return new ValidationFailed({ fields: firstPerPath(out.unknown.length > 0 ? out.unknown : out.known) })
}

/** Whether `contentType` is `application/json`, with any parameters. */
export const isJson = (contentType: string | undefined): boolean =>
  contentType?.split(";")[0]?.trim().toLowerCase() === "application/json"

/**
 * On every endpoint: answers what a request doesn't decode as Plat5's 400 or 422, and a
 * defect (a bug, a database gone) as the 500, logged with its cause.
 */
export class Plat5Request extends HttpApiMiddleware.Service<Plat5Request>()("api/plat5/Plat5Request", {
  error: [HttpErrors.InvalidRequest, HttpErrors.ValidationFailed, HttpErrors.InternalError]
}) {
  static readonly layer = Layer.succeed(Plat5Request, (httpEffect, { endpoint }) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (endpoint.payload.size > 0 && HttpMethod.hasBody(request.method)) {
        if (!isJson(request.headers["content-type"])) return yield* new InvalidRequest()
        const text = yield* Effect.orDie(request.text)
        if (!isJsonText(text)) return yield* new InvalidRequest()
      }
      // The handler's other errors pass through as they are.
      return yield* httpEffect.pipe(
        Effect.catch((error: unknown) => Effect.fail(plat5Error(error) as never)),
        Effect.catchDefect((defect) =>
          Effect.logError("unexpected error").pipe(
            Effect.annotateLogs({ error_message: String(defect) }),
            Effect.andThen(Effect.fail(new InternalError() as never))
          )
        )
      )
    }))
}

/** A schema error as Plat5's 400 or 422; any other error as it is. */
const plat5Error = (error: unknown): unknown => {
  if (!HttpApiError.HttpApiSchemaError.is(error)) return error
  switch (error.kind) {
    case "Headers":
      return new InvalidRequest()
    case "Params":
    case "Query":
    case "Payload":
      return validationFailed(error.cause.issue)
    default:
      return error
  }
}

/** Whether `text` is one JSON value. */
const isJsonText = (text: string): boolean => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
