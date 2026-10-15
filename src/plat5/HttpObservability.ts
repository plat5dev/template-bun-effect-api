import {
  Headers,
  HttpApp,
  HttpMiddleware,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse
} from "@effect/platform"
import { Effect, Metric, MetricBoundaries, Option } from "effect"
import { FALLBACK_VALIDATION } from "./Errors.js"

const ULID_OR_UUID =
  /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** Low-cardinality route label for metrics (plat5/docs/telemetry.md). */
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

// plat5/docs/telemetry.md standard HTTP buckets
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

type SubjectIds = {
  readonly userId: string | undefined
  readonly organizationId: string | undefined
}

const emptySubject: SubjectIds = {
  userId: undefined,
  organizationId: undefined
}

const decodeSeg = (seg: string): string => {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/** Subject ids from the listen paths, when the URL is one of those paths. */
const subjectFromPath = (url: string): SubjectIds => {
  const pathname = (url.split("?")[0] ?? url).replace(/\/$/, "") || "/"
  const parts = pathname.split("/")
  const userId = parts[2]
  if (parts.length === 4 && parts[1] === "users" && parts[3] === "profile" && userId) {
    return {
      userId: decodeSeg(userId),
      organizationId: undefined
    }
  }

  const organizationId = parts[2]
  if (parts[1] !== "organizations" || parts[3] !== "projects" || !organizationId) {
    return emptySubject
  }

  const rest = parts.slice(4)
  const filled = rest.every((seg) => seg !== "")
  const matched =
    filled &&
    (rest.length === 0 ||
      rest.length === 1 ||
      (rest.length === 2 && rest[1] === "tasks") ||
      (rest.length === 3 && rest[1] === "tasks"))
  if (!matched) return emptySubject

  return {
    userId: undefined,
    organizationId: decodeSeg(organizationId)
  }
}

/**
 * Plat5 HTTP observability: JSON access log, OTLP-bound metrics, HTTP server span.
 * @see plat5/docs/telemetry.md
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
      const exit = yield* Effect.exit(httpApp)
      const response = plat5Envelope(HttpServerError.exitResponse(exit), requestId)
      const status = response.status
      const span = Option.getOrUndefined(yield* Effect.option(Effect.currentSpan))
      const durationMs = Math.round((performance.now() - started) * 100) / 100
      const durationSeconds = durationMs / 1000
      const subject = subjectFromPath(path)

      yield* Effect.annotateCurrentSpan("http.response.status_code", status)
      if (subject.userId !== undefined) {
        yield* Effect.annotateCurrentSpan("user.id", subject.userId)
      }
      if (subject.organizationId !== undefined) {
        yield* Effect.annotateCurrentSpan("organization.id", subject.organizationId)
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
      if (subject.userId !== undefined) line.user_id = subject.userId
      if (subject.organizationId !== undefined) line.organization_id = subject.organizationId
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

type DecodeIssue = { readonly _tag?: string; readonly path?: ReadonlyArray<unknown> }

/**
 * Every error answers in the Plat5 envelope (plat5/docs/api-errors.md):
 *
 * - Effect's own 400 for a body or path that doesn't decode becomes a 422
 *   VALIDATION_ERROR, with a field per issue.
 * - An envelope with no request_id gets the gateway's X-Request-ID, so a handler
 *   doesn't have to pass it to every error.
 */
const plat5Envelope = (
  response: HttpServerResponse.HttpServerResponse,
  requestId: string | null
): HttpServerResponse.HttpServerResponse => {
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

/** A sentence for one decode issue (plat5/docs/error-copy.md: no schema text). */
const issueMessage = (issue: DecodeIssue, path: string): string => {
  const field = path.split(".").pop() ?? ""
  if (issue._tag === "Missing" && field) {
    const label = field.replace(/_/g, " ")
    return `${label.charAt(0).toUpperCase()}${label.slice(1)} is required.`
  }
  return FALLBACK_VALIDATION
}
