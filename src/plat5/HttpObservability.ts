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

type SubjectIds = {
  readonly userId: string | undefined
  readonly organizationId: string | undefined
  readonly memberId: string | undefined
}

const emptySubject: SubjectIds = {
  userId: undefined,
  organizationId: undefined,
  memberId: undefined
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
      organizationId: undefined,
      memberId: undefined
    }
  }

  const organizationId = parts[2]
  const memberId = parts[4]
  if (
    parts[1] !== "organizations" ||
    parts[3] !== "members" ||
    parts[5] !== "projects" ||
    !organizationId ||
    !memberId
  ) {
    return emptySubject
  }

  const rest = parts.slice(6)
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
    organizationId: decodeSeg(organizationId),
    memberId: decodeSeg(memberId)
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

      const exit = yield* Effect.exit(httpApp)
      const response = HttpServerError.exitResponse(exit)
      const status = response.status
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
      if (subject.memberId !== undefined) {
        yield* Effect.annotateCurrentSpan("member.id", subject.memberId)
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
      if (subject.userId !== undefined) line.user_id = subject.userId
      if (subject.organizationId !== undefined) line.organization_id = subject.organizationId
      if (subject.memberId !== undefined) line.member_id = subject.memberId
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
