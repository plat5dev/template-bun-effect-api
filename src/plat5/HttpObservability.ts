import {
  Headers,
  HttpApi,
  HttpApp,
  HttpBody,
  HttpMiddleware,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse
} from "@effect/platform"
import { Effect, Metric, MetricBoundaries, Option } from "effect"
import {
  fieldError,
  internalError,
  MAX_BODY_BYTES,
  notFound,
  payloadTooLarge,
  serviceUnavailable
} from "./Errors.js"

/** One route of the API: its method, its path template, and a matcher for its params. */
type Route = {
  readonly method: string
  readonly template: string
  readonly pattern: RegExp
  readonly params: ReadonlyArray<string>
}

/**
 * The API's routes, from its definition. A path matches as the router matches it: ignoring
 * case and a trailing slash. HEAD matches a GET route.
 */
const routesOf = (api: HttpApi.HttpApi.Any): ReadonlyArray<Route> => {
  const routes: Array<Route> = []
  HttpApi.reflect(api as any, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      const template = endpoint.path.replace(/(.)\/$/, "$1")
      const params: Array<string> = []
      const source = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:(\w+)/g, (_, name) => {
        params.push(name)
        return "([^/]+)"
      })
      routes.push({ method: endpoint.method, template, pattern: new RegExp(`^${source}/?$`, "i"), params })
    }
  })
  return routes
}

/** The route serving `method` on `path`, with its params, or undefined for none. */
const match = (routes: ReadonlyArray<Route>, method: string, path: string) => {
  const wanted = method === "HEAD" ? "GET" : method
  for (const route of routes) {
    if (route.method !== wanted) continue
    const found = route.pattern.exec(path)
    if (!found) continue
    const params: Record<string, string> = {}
    route.params.forEach((name, i) => {
      params[name] = decodeSeg(found[i + 1]!)
    })
    return { template: route.template, params }
  }
  return undefined
}

const decodeSeg = (seg: string): string => {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

// plat5 docs/reference/telemetry.md standard HTTP buckets
const httpDurationBoundaries = MetricBoundaries.fromIterable([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5
])

const recordHttpMetrics = (
  method: string,
  route: string,
  status: string,
  durationSeconds: number
) =>
  Effect.zipRight(
    Metric.counter("http_requests_total", {
      description: "Total HTTP requests handled by the api service",
      incremental: true
    }).pipe(
      Metric.tagged("route", route),
      Metric.tagged("method", method),
      Metric.tagged("status", status),
      Metric.update(1)
    ),
    Metric.histogram(
      "http_request_duration_seconds",
      httpDurationBoundaries,
      "HTTP request latency observed by the api service"
    ).pipe(
      Metric.tagged("route", route),
      Metric.tagged("method", method),
      Metric.update(durationSeconds)
    )
  )

/**
 * The ids the front door gave this request (plat5 docs/reference/telemetry.md): the user on
 * a user route, the environment node and the caller's member on an environment route. Log
 * fields use them as named; span attributes add the `plat5.` prefix. The ids are the
 * matched route's `user_id` and `environment_id` params.
 */
const callerIds = (
  params: Record<string, string>,
  headers: Headers.Headers
): ReadonlyArray<readonly [field: string, value: string]> => {
  const ids: Array<readonly [string, string]> = []
  if (params.user_id) ids.push(["user_id", params.user_id])
  if (params.environment_id) ids.push(["node_id", params.environment_id])
  const memberId = Option.getOrUndefined(Headers.get(headers, "x-plat5-member-id"))
  if (memberId) ids.push(["member_id", memberId])
  return ids
}

/** What a 5xx is, for its log line and span: an unavailable dependency, or our own fault. */
const errorKind = (code: string | undefined): string =>
  code === "SERVICE_UNAVAILABLE" ? "network" : "internal"

/**
 * Plat5 HTTP observability for `api`'s routes: JSON access log, metrics, HTTP server span,
 * and every error in the Plat5 envelope.
 * @see plat5 docs/reference/telemetry.md
 */
export const httpObservability = (api: HttpApi.HttpApi.Any) => {
  const routes = routesOf(api)
  return HttpMiddleware.make((httpApp) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const started = performance.now()
      const path = request.url.split("?")[0] ?? request.url
      const method = request.method
      const matched = match(routes, method, path)
      const route = matched?.template ?? "unknown"
      const spanName = matched ? `${method} ${matched.template}` : method

      // As sent, or null without one (or with an empty one).
      const requestId = Option.getOrNull(Headers.get(request.headers, "x-request-id")) || null

      const attributes: Record<string, string> = {
        "http.request.method": method,
        "url.path": path
      }
      if (matched) attributes["http.route"] = matched.template

      return yield* Effect.gen(function*() {
        if (requestId !== null) {
          yield* Effect.annotateCurrentSpan("request_id", requestId)
        }

        // The server writes the response before this middleware gets it back, so the
        // envelope fix is a pre-response handler; the status logged below is the same.
        yield* HttpApp.appendPreResponseHandler((_request, response) =>
          Effect.succeed(plat5Envelope(response, requestId).response)
        )
        const exit = yield* Effect.exit(withBodyLimit(httpApp, request, requestId))
        const { error, response } = plat5Envelope(HttpServerError.exitResponse(exit), requestId)
        const status = response.status
        const span = Option.getOrUndefined(yield* Effect.option(Effect.currentSpan))
        // To the microsecond.
        const durationMs = Math.floor((performance.now() - started) * 1000) / 1000
        const ids = callerIds(matched?.params ?? {}, request.headers)

        yield* Effect.annotateCurrentSpan("http.response.status_code", status)
        for (const [field, value] of ids) {
          yield* Effect.annotateCurrentSpan(`plat5.${field}`, value)
        }
        if (status >= 500) {
          yield* Effect.annotateCurrentSpan("error.kind", errorKind(error?.code))
        }

        yield* recordHttpMetrics(method, route, String(status), durationMs / 1000)

        const line: Record<string, unknown> = {
          timestamp: new Date().toISOString(),
          level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
          message: "request completed",
          route,
          method,
          status,
          duration_ms: durationMs
        }
        if (requestId !== null) line.request_id = requestId
        if (span) {
          line.trace_id = span.traceId
          line.span_id = span.spanId
        }
        for (const [field, value] of ids) line[field] = value
        if (status >= 500) {
          line.error_kind = errorKind(error?.code)
          line.error_message = error ? `${error.code}: ${error.message}` : "request failed"
        }

        console.log(JSON.stringify(line))
        return yield* exit
      }).pipe(
        Effect.withSpan(spanName, {
          kind: "server",
          attributes
        })
      )
    })
  )
}

/** A body over `MAX_BODY_BYTES` is a 413, before routing or anything reads it. */
const withBodyLimit = <E, R>(
  httpApp: HttpApp.Default<E, R>,
  request: HttpServerRequest.HttpServerRequest,
  requestId: string | null
): HttpApp.Default<E, R> => {
  const length = Number(Option.getOrElse(Headers.get(request.headers, "content-length"), () => "0"))
  return length > MAX_BODY_BYTES
    ? Effect.succeed(HttpServerResponse.unsafeJson(payloadTooLarge(MAX_BODY_BYTES, requestId), { status: 413 }))
    : httpApp
}

const JSON_TYPE = "application/json; charset=utf-8"

const envelope = (body: { readonly error: { readonly code: string } }, status: number) =>
  HttpServerResponse.unsafeJson(body, { status, contentType: JSON_TYPE })

type ErrorEnvelope = { error: { code: string; message: string; request_id: string | null } }

/**
 * Every error answers in the Plat5 envelope (plat5 docs/reference/errors.md), JSON with a
 * charset:
 *
 * - The API's own errors as they are, with the request's X-Request-ID as their request_id,
 *   so a handler doesn't have to pass it to every error.
 * - Anything else by its status, never with the framework's text: a 404 or 405 is the
 *   unknown route's NOT_FOUND (no Allow header), a 400 a 422 VALIDATION_ERROR at `body`, a
 *   413 PAYLOAD_TOO_LARGE, a 503 SERVICE_UNAVAILABLE, and any other the fallback 500.
 *
 * Returns the error it answers with, for the request's log line.
 */
const plat5Envelope = (
  response: HttpServerResponse.HttpServerResponse,
  requestId: string | null
): { response: HttpServerResponse.HttpServerResponse; error?: ErrorEnvelope["error"] } => {
  const body = response.body
  const json = body._tag === "Uint8Array" && body.contentType.startsWith("application/json")
  if (response.status < 400) {
    // A success's JSON with a charset, as the errors have it.
    return json && body._tag === "Uint8Array" && body.contentType === "application/json"
      ? { response: HttpServerResponse.setBody(response, HttpBody.uint8Array(body.body, JSON_TYPE)) }
      : { response }
  }
  let data: ErrorEnvelope | undefined
  if (json && body._tag === "Uint8Array") {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body.body))
      if (typeof parsed?.error?.code === "string") data = parsed
    } catch {
      // Not ours.
    }
  }
  if (data !== undefined) {
    data.error.request_id ??= requestId
    return { response: envelope(data, response.status), error: data.error }
  }
  const [status, fallback]: [number, ErrorEnvelope] = response.status === 404 || response.status === 405
    ? [404, notFound("resource", null, requestId)]
    : response.status === 400
    ? [422, fieldError("body", undefined, requestId)]
    : response.status === 413
    ? [413, payloadTooLarge(MAX_BODY_BYTES, requestId)]
    : response.status === 503
    ? [503, serviceUnavailable(requestId)]
    : [500, internalError(requestId)]
  return { response: envelope(fallback, status), error: fallback.error }
}
