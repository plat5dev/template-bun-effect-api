/**
 * Plat5 HTTP observability: server spans, Prometheus/OTLP HTTP metrics, structured access logs,
 * query parameter redaction, and defect-to-500 envelope conversion.
 */
import { Data, Effect, Metric, Option } from "effect"
import { HttpRouter, HttpServerError, HttpServerRequest, type HttpServerResponse, HttpTraceContext } from "effect/http"
import { HttpApi, type HttpApiGroup } from "effect/http-api"
import { envelope, errorResponse, InternalError, ServiceUnavailable } from "./Errors.js"

const REDACTED_QUERY_KEYS: ReadonlySet<string> = new Set([
  "sig",
  "Signature",
  "AWSAccessKeyId",
  "X-Amz-Signature",
  "X-Amz-Credential",
  "X-Amz-Security-Token",
  "X-Goog-Signature"
])

export const redactQuery = (query: string): string =>
  query
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=")
      return eq >= 0 && REDACTED_QUERY_KEYS.has(part.slice(0, eq)) ? `${part.slice(0, eq)}=REDACTED` : part
    })
    .join("&")

type RouteTemplate = { readonly method: string; readonly template: string; readonly pattern: RegExp }

const compileRoute = (method: string, path: string): RouteTemplate => {
  const template = path.replace(/(.)\/$/, "$1")
  const source = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:\w+/g, "[^/]+")
  return { method, template, pattern: new RegExp(`^${source}/?$`, "i") }
}

const templatesOf = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  extraRoutes: ReadonlyArray<{ readonly method: string; readonly template: string }>
): ReadonlyArray<RouteTemplate> => {
  const routes: Array<RouteTemplate> = extraRoutes.map((r) => compileRoute(r.method, r.template))
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      routes.push(compileRoute(endpoint.method, endpoint.path))
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
  boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
})

const callerIds = (headers: HttpServerRequest.HttpServerRequest["headers"]) =>
  Object.entries({
    user_id: headers["x-plat5-user-id"],
    node_id: headers["x-plat5-project-id"],
    member_id: headers["x-plat5-member-id"]
  }).filter((entry): entry is [string, string] => !!entry[1])

class ServerError<A> extends Data.TaggedError("ServerError")<{ readonly message: string; readonly exit: A }> {}

const serverError = (status: number) => {
  const { error } = envelope(status === 503 ? new ServiceUnavailable() : new InternalError(), null)
  return { error_type: status === 503 ? "network" : "internal", error_message: `${error.code}: ${error.message}` }
}

/** Global router middleware turning unexpected defects into Plat5's 500 envelope. */
export const catchDefectsLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.catchDefect(httpEffect, (defect) =>
      Effect.logError("unexpected error").pipe(
        Effect.annotateLogs({ error_message: defect instanceof Error ? defect.message : String(defect) }),
        Effect.andThen(errorResponse(new InternalError(), 500))
      )
    ),
  { global: true }
)

export const httpObservability = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  extraRoutes: ReadonlyArray<{ readonly method: string; readonly template: string }> = []
) => {
  const templates = templatesOf(api, extraRoutes)
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
        "url.scheme": URL.parse(request.originalUrl)?.protocol.replace(/:$/, "") ?? "http"
      }
      if (query !== "") attributes["url.query"] = redactQuery(query)
      if (template) attributes["http.route"] = template
      if (requestId !== null) attributes.request_id = requestId
      for (const [field, value] of ids) attributes[`plat5.${field}`] = value

      return yield* Effect.gen(function*() {
        const exit = yield* Effect.exit(httpApp)
        const status = HttpServerError.exitResponse(exit).status
        const durationMs = Math.floor((performance.now() - started) * 1000) / 1000

        yield* Effect.annotateCurrentSpan("http.response.status_code", status)
        if (status >= 500) yield* Effect.annotateCurrentSpan("error.type", serverError(status).error_type)

        yield* Metric.update(Metric.withAttributes(httpRequests, { route, method, status: String(status) }), 1)
        yield* Metric.update(Metric.withAttributes(httpDuration, { route, method }), durationMs / 1000)

        const fields: Record<string, unknown> = {
          route,
          method,
          status,
          duration_ms: durationMs,
          ...Object.fromEntries(ids)
        }
        if (status >= 500) Object.assign(fields, serverError(status))

        const log = status >= 500 ? Effect.logError : status >= 400 ? Effect.logWarning : Effect.logInfo
        yield* log("request completed").pipe(Effect.annotateLogs(fields))
        if (status >= 500) return yield* new ServerError({ message: serverError(status).error_message, exit })
        return exit
      }).pipe(
        Effect.withSpan(template ? `${method} ${template}` : method, {
          kind: "server",
          attributes,
          parent: Option.getOrUndefined(HttpTraceContext.w3c(request.headers))
        }),
        Effect.catchTag("ServerError", (error) => Effect.succeed(error.exit)),
        Effect.flatten
      )
    })
}
