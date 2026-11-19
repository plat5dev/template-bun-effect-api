/**
 * Structured JSON stdout logging following Plat5 conventions:
 * `timestamp`, `level`, `message`, plus `request_id`, `trace_id`, `span_id`, and annotations.
 */
import { Cause, Context, Effect, Logger, type LogLevel, References, Tracer } from "effect"
import { HttpServerRequest } from "effect/http"

export type Level = "debug" | "info" | "warn" | "error"

const levels: Record<LogLevel.LogLevel, Level> = {
  All: "debug",
  Trace: "debug",
  Debug: "debug",
  Info: "info",
  Warn: "warn",
  Error: "error",
  Fatal: "error",
  None: "info"
}

const formatPart = (part: unknown): string => {
  if (typeof part === "string") return part
  if (part instanceof Error) return part.message
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

export const line = (
  level: Level,
  message: string,
  fields: Readonly<Record<string, unknown>> = {},
  date = new Date()
): string => JSON.stringify({ timestamp: date.toISOString(), level, message, ...fields })

export const logger = Logger.make<unknown, void>(({ cause, date, fiber, logLevel, message }) => {
  const parts = Array.isArray(message) ? message : [message]
  const fields: Record<string, unknown> = {}

  const request = Context.getOrUndefined(fiber.context, HttpServerRequest.HttpServerRequest)
  const requestId = request?.headers["x-request-id"]
  if (requestId) fields.request_id = requestId

  const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan)
  if (span !== undefined) {
    fields.trace_id = span.traceId
    fields.span_id = span.spanId
  }

  Object.assign(fields, fiber.getRef(References.CurrentLogAnnotations))

  if (cause.reasons.length > 0 && !("error_message" in fields)) {
    const err = Cause.squash(cause)
    fields.error_message = err instanceof Error ? err.message : String(err)
  }

  console.log(line(levels[logLevel], parts.map(formatPart).join(" "), fields, date))
})

export const telemetryError = (message: string) =>
  Effect.logError("telemetry error").pipe(Effect.annotateLogs({ error_message: message }))

export const layer = Logger.layer([logger])
