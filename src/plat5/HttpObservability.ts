/**
 * Plat5 HTTP observability (plat5 docs/reference/telemetry.md): each request's server span,
 * its metrics, and its JSON access line.
 */
import { Data, Effect, Metric, Option } from "effect"
import { HttpServerError, HttpServerRequest, type HttpServerResponse, HttpTraceContext } from "effect/http"
import { HttpApi, type HttpApiGroup } from "effect/http-api"
import { envelope, InternalError, ServiceUnavailable } from "./Errors.js"
import { redactQuery } from "./Redact.js"

/**
 * The API's route templates, by method, each with a matcher. A path matches as the router
 * matches it: ignoring case and a trailing slash. HEAD matches a GET route.
 */
const templatesOf = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>
): ReadonlyArray<{ readonly method: string; readonly template: string; readonly pattern: RegExp }> => {
  const routes: Array<{ method: string; template: string; pattern: RegExp }> = []
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      const template = endpoint.path.replace(/(.)\/$/, "$1")
      const source = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:\w+/g, "[^/]+")
      routes.push({ method: endpoint.method, template, pattern: new RegExp(`^${source}/?$`, "i") })
    }
  })
  return routes
}

const httpRequests = Metric.counter("http_requests_total", {
  description: "Total HTTP requests handled by the api service",
  incremental: true
})

const httpDuration = Metric.histogram("http_request_duration_seconds", {
  description: "HTTP request latency observed by the api service",
  // plat5 docs/reference/telemetry.md standard HTTP buckets
  boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
})

/**
 * The ids the front door gave this request, as log fields (span attributes add `plat5.`):
 * the caller's user on a user route, the project node and the caller's member on a project
 * route (plat5 docs/reference/headers.md).
 */
const callerIds = (headers: HttpServerRequest.HttpServerRequest["headers"]) =>
  Object.entries({
    user_id: headers["x-plat5-user-id"],
    node_id: headers["x-plat5-project-id"],
    member_id: headers["x-plat5-member-id"]
  }).filter((entry): entry is [string, string] => !!entry[1])

/** A 5xx's span fails with this, so it's `Error` (plat5 docs/reference/telemetry.md#http-server-spans). */
class ServerError<A> extends Data.TaggedError("ServerError")<{ readonly message: string; readonly exit: A }> {}

/**
 * A 5xx's `error_type` and `error_message` (plat5 docs/reference/telemetry.md#error-fields-5xx-only):
 * a 503 is an unavailable dependency, any other our own fault. Each has one sentence.
 */
const serverError = (status: number) => {
  const { error } = envelope(status === 503 ? new ServiceUnavailable() : new InternalError(), null)
  return { error_type: status === 503 ? "network" : "internal", error_message: `${error.code}: ${error.message}` }
}

/**
 * Each request to `api`: a server span named by its route template, parented on its
 * traceparent; `http_requests_total` and `http_request_duration_seconds`; and one access
 * line, `warn` on a 4xx and `error` on a 5xx.
 */
export const httpObservability = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>
) => {
  const templates = templatesOf(api)
  return <E, R>(
    httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const started = performance.now()
      const [path = "", query = ""] = request.url.split(/\?(.*)/s)
      const method = request.method
      const wanted = method === "HEAD" ? "GET" : method
      const template = templates.find((route) => route.method === wanted && route.pattern.test(path))?.template
      const route = template ?? "unknown"
      const requestId = request.headers["x-request-id"] || null
      const ids = callerIds(request.headers)

      const attributes: Record<string, string> = {
        "http.request.method": method,
        "url.path": path,
        // The scheme of the request this server received.
        "url.scheme": URL.parse(request.originalUrl)?.protocol.replace(/:$/, "") ?? "http"
      }
      if (query !== "") attributes["url.query"] = redactQuery(query)
      if (template) attributes["http.route"] = template
      if (requestId !== null) attributes.request_id = requestId
      for (const [field, value] of ids) attributes[`plat5.${field}`] = value

      return yield* Effect.gen(function*() {
        const exit = yield* Effect.exit(httpApp)
        const status = HttpServerError.exitResponse(exit).status
        const span = Option.getOrUndefined(yield* Effect.option(Effect.currentSpan))
        // To the microsecond.
        const durationMs = Math.floor((performance.now() - started) * 1000) / 1000

        yield* Effect.annotateCurrentSpan("http.response.status_code", status)
        if (status >= 500) yield* Effect.annotateCurrentSpan("error.type", serverError(status).error_type)

        yield* Metric.update(Metric.withAttributes(httpRequests, { route, method, status: String(status) }), 1)
        yield* Metric.update(Metric.withAttributes(httpDuration, { route, method }), durationMs / 1000)

        const fields: Record<string, unknown> = { route, method, status, duration_ms: durationMs }
        if (requestId !== null) fields.request_id = requestId
        if (span) Object.assign(fields, { trace_id: span.traceId, span_id: span.spanId })
        Object.assign(fields, Object.fromEntries(ids))
        if (status >= 500) Object.assign(fields, serverError(status))

        const log = status >= 500 ? Effect.logError : status >= 400 ? Effect.logWarning : Effect.logInfo
        yield* log("request completed").pipe(Effect.annotateLogs(fields))
        if (status >= 500) return yield* new ServerError({ message: serverError(status).error_message, exit })
        return exit
      }).pipe(
        Effect.withSpan(template ? `${method} ${template}` : method, {
          kind: "server",
          attributes,
          // From traceparent (plat5 docs/reference/telemetry.md#traces).
          parent: Option.getOrUndefined(HttpTraceContext.w3c(request.headers))
        }),
        // The span has ended, failed on a 5xx; the request goes on as it was.
        Effect.catchTag("ServerError", (error) => Effect.succeed(error.exit)),
        Effect.flatten
      )
    })
}
