import {
  Headers,
  HttpApp,
  HttpMiddleware,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse
} from "@effect/platform"
import { Effect, Metric, MetricBoundaries, Option } from "effect"
import { FALLBACK_VALIDATION, fieldError, notFound, payloadTooLarge } from "./Errors.js"

/** The largest request body the API reads; over it is a 413. */
export const MAX_BODY_BYTES = 1024 * 1024

const ULID_OR_UUID =
  /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** Low-cardinality route label for metrics (plat5 docs/reference/telemetry.md). */
export const normalizeRoute = (path: string): string => {
  const bare = path.split("?")[0] || "/"
  const parts = bare.split("/").map((seg) => {
    if (seg === "") return seg
    if (ULID_OR_UUID.test(seg)) return "{id}"
    if (/^\d+$/.test(seg)) return "{id}"
    return seg
  })
  const joined = parts.join("/")
  return joined.length > 80 ? joined.slice(0, 80) : joined
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
      description: "Total HTTP requests processed",
      incremental: true
    }).pipe(
      Metric.tagged("method", method),
      Metric.tagged("route", route),
      Metric.tagged("status", status),
      Metric.update(1)
    ),
    Metric.histogram(
      "http_request_duration_seconds",
      httpDurationBoundaries,
      "HTTP request duration in seconds"
    ).pipe(
      Metric.tagged("method", method),
      Metric.tagged("route", route),
      Metric.update(durationSeconds)
    )
  )

const decodeSeg = (seg: string): string => {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/**
 * The ids the front door gave this request (plat5 docs/reference/telemetry.md): the user on
 * a user route, the project node and the caller's member on a project route. Log fields use
 * them as named; span attributes add the `plat5.` prefix. The ids are read from the API's
 * own paths, `/users/{user_id}/profile` and `/projects/{project_id}/tasks…`.
 */
const callerIds = (
  path: string,
  headers: Headers.Headers
): ReadonlyArray<readonly [field: string, value: string]> => {
  const ids: Array<readonly [string, string]> = []
  const parts = (path.replace(/\/$/, "") || "/").split("/")
  const id = parts[2]
  if (id && parts[1] === "users" && parts[3] === "profile" && parts.length === 4) {
    ids.push(["user_id", decodeSeg(id)])
  }
  if (id && parts[1] === "projects" && parts[3] === "tasks" && parts.length <= 5) {
    ids.push(["node_id", decodeSeg(id)])
  }
  const memberId = Option.getOrUndefined(Headers.get(headers, "x-plat5-member-id"))
  if (memberId) ids.push(["member_id", memberId])
  return ids
}

/**
 * Plat5 HTTP observability: JSON access log, OTLP-bound metrics, HTTP server span.
 * @see plat5 docs/reference/telemetry.md
 */
export const httpObservability = HttpMiddleware.make((httpApp) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const started = performance.now()
    const path = request.url.split("?")[0] ?? request.url
    const route = normalizeRoute(path)
    const method = request.method
    const spanName = `${method} ${route}`

    const requestId = Option.getOrNull(Headers.get(request.headers, "x-request-id"))

    const attributes: Record<string, string> = {
      "http.request.method": method,
      "url.path": path,
      "http.route": route
    }

    return yield* Effect.gen(function*() {
      if (requestId !== null) {
        yield* Effect.annotateCurrentSpan("request_id", requestId)
      }

      // The server writes the response before this middleware gets it back, so the
      // envelope fix is a pre-response handler; the status logged below is the same.
      yield* HttpApp.appendPreResponseHandler((_request, response) =>
        Effect.succeed(plat5Envelope(response, requestId))
      )
      const exit = yield* Effect.exit(withBodyLimit(httpApp, request, requestId))
      const response = plat5Envelope(HttpServerError.exitResponse(exit), requestId)
      const status = response.status
      const span = Option.getOrUndefined(yield* Effect.option(Effect.currentSpan))
      const durationMs = Math.round((performance.now() - started) * 100) / 100
      const durationSeconds = durationMs / 1000
      const ids = callerIds(path, request.headers)

      yield* Effect.annotateCurrentSpan("http.response.status_code", status)
      for (const [field, value] of ids) {
        yield* Effect.annotateCurrentSpan(`plat5.${field}`, value)
      }
      if (status >= 500) {
        yield* Effect.annotateCurrentSpan("error.kind", "internal")
      }

      yield* recordHttpMetrics(method, route, String(status), durationSeconds)

      const line: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        level: status >= 500 ? "error" : "info",
        message: "request completed",
        route: path,
        method,
        status,
        duration_ms: durationMs,
        request_id: requestId
      }
      if (span) {
        line.trace_id = span.traceId
        line.span_id = span.spanId
      }
      for (const [field, value] of ids) line[field] = value
      if (status >= 500) {
        line.error_kind = "internal"
        line.error_message = "request failed"
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

/** A body over `MAX_BODY_BYTES` is a 413, before anything reads it. */
const withBodyLimit = <E, R>(
  httpApp: HttpApp.Default<E, R>,
  request: HttpServerRequest.HttpServerRequest,
  requestId: string | null
): HttpApp.Default<E, R> => {
  const length = Number(Option.getOrElse(Headers.get(request.headers, "content-length"), () => "0"))
  return length > MAX_BODY_BYTES
    ? Effect.succeed(
      HttpServerResponse.unsafeJson(payloadTooLarge(MAX_BODY_BYTES, requestId), { status: 413 })
    )
    : httpApp
}

type DecodeIssue = { readonly _tag?: string; readonly path?: ReadonlyArray<unknown> }

/**
 * Every error answers in the Plat5 envelope (plat5 docs/reference/errors.md):
 *
 * - Effect's own 400 for a body or path that doesn't decode becomes a 422
 *   VALIDATION_ERROR, with a field per issue.
 * - The server's bodiless answers, whose text wouldn't be product copy anyway, get the
 *   envelope with a fallback sentence: a 404 for a path no route serves is NOT_FOUND, and
 *   a 400 for a body that isn't JSON is a 422 VALIDATION_ERROR on `body`.
 * - An envelope with no request_id gets the gateway's X-Request-ID, so a handler
 *   doesn't have to pass it to every error.
 */
const plat5Envelope = (
  response: HttpServerResponse.HttpServerResponse,
  requestId: string | null
): HttpServerResponse.HttpServerResponse => {
  if (response.status === 404 && response.body._tag === "Empty") {
    return HttpServerResponse.unsafeJson(notFound("resource", null, requestId), { status: 404 })
  }
  if (response.status === 400 && response.body._tag === "Empty") {
    return HttpServerResponse.unsafeJson(fieldError("body", undefined, requestId), { status: 422 })
  }
  if (response.status < 400 || response.body._tag !== "Uint8Array") return response
  let data: any
  try {
    data = JSON.parse(new TextDecoder().decode(response.body.body))
  } catch {
    return response
  }
  if (data?._tag === "HttpApiDecodeError") {
    const issues: ReadonlyArray<DecodeIssue> = Array.isArray(data.issues) ? data.issues : []
    const fields = issues.map((issue) => {
      const path = (issue.path ?? []).map(String).join(".")
      return { path, message: issueMessage(issue, path) }
    })
    return HttpServerResponse.unsafeJson(
      {
        error: {
          type: "invalid_request_error",
          code: "VALIDATION_ERROR",
          message: fields[0]?.message ?? FALLBACK_VALIDATION,
          request_id: requestId,
          details: { fields }
        }
      },
      { status: 422 }
    )
  }
  if (data?.error && data.error.request_id == null && requestId) {
    data.error.request_id = requestId
    return HttpServerResponse.unsafeJson(data, { status: response.status })
  }
  return response
}

/** A sentence for one decode issue (plat5 docs/reference/error-copy.md: no schema text). */
const issueMessage = (issue: DecodeIssue, path: string): string => {
  const field = path.split(".").pop() ?? ""
  if (issue._tag === "Missing" && field) {
    const label = field.replace(/_/g, " ")
    return `${label.charAt(0).toUpperCase()}${label.slice(1)} is required.`
  }
  return FALLBACK_VALIDATION
}
