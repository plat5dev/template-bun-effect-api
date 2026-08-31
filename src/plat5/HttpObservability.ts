import {
  Headers,
  HttpMiddleware,
  HttpServerError,
  HttpServerRequest
} from "@effect/platform"
import { Effect, Metric, MetricBoundaries, Option } from "effect"

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

const requestScheme = (headers: Parameters<typeof Headers.get>[0]): string => {
  const forwarded = Option.getOrUndefined(Headers.get(headers, "x-forwarded-proto"))
  const first = forwarded?.split(",")[0]?.trim()
  return first || "http"
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
    const query = request.url.includes("?")
      ? request.url.slice(request.url.indexOf("?") + 1)
      : undefined
    const route = normalizeRoute(path)
    const method = request.method
    const scheme = requestScheme(request.headers)
    const spanName = `${method} ${route}`

    const requestId = Option.getOrNull(Headers.get(request.headers, "x-request-id"))
    const userId = Option.getOrUndefined(Headers.get(request.headers, "x-user-id"))
    const organizationId = Option.getOrUndefined(
      Headers.get(request.headers, "x-organization-id")
    )
    const memberId = Option.getOrUndefined(
      Headers.get(request.headers, "x-member-id")
    )

    const attributes: Record<string, string> = {
      "http.request.method": method,
      "url.path": path,
      "url.scheme": scheme,
      "http.route": route
    }
    if (query) attributes["url.query"] = query

    return yield* Effect.gen(function*() {
      if (requestId !== null) {
        yield* Effect.annotateCurrentSpan("request_id", requestId)
      }
      // Only set when gateway injected the header — never invent (telemetry.md).
      if (userId !== undefined) {
        yield* Effect.annotateCurrentSpan("user.id", userId)
      }
      if (organizationId !== undefined) {
        yield* Effect.annotateCurrentSpan("organization.id", organizationId)
      }
      if (memberId !== undefined) {
        yield* Effect.annotateCurrentSpan("member.id", memberId)
      }

      const exit = yield* Effect.exit(httpApp)
      const response = HttpServerError.exitResponse(exit)
      const status = response.status
      const durationMs = Math.round((performance.now() - started) * 100) / 100
      const durationSeconds = durationMs / 1000

      yield* Effect.annotateCurrentSpan("http.response.status_code", status)
      if (status >= 500) {
        yield* Effect.annotateCurrentSpan("error.kind", "internal")
        yield* Effect.annotateCurrentSpan("error.type", String(status))
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
      if (userId !== undefined) line.user_id = userId
      if (organizationId !== undefined) line.organization_id = organizationId
      if (memberId !== undefined) line.member_id = memberId
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
