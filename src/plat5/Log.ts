/**
 * Plat5's log lines (plat5 docs/reference/telemetry.md#logs): one JSON object per line on
 * stdout, `timestamp`, `level` and `message` first, then the line's fields.
 *
 * Code logs with Effect (`Effect.logInfo`, `Effect.logWarning`, `Effect.logError`) and
 * names its fields with `Effect.annotateLogs`; `layer` writes every log as a Plat5 line.
 * `line` is the same line, for code that runs outside Effect.
 */
import { Cause, Effect, Logger, type LogLevel, Predicate, References } from "effect"

export type Level = "debug" | "info" | "warn" | "error"

/** One log line: its fields after `timestamp`, `level` and `message`. */
export const line = (level: Level, message: string, fields: Readonly<Record<string, unknown>> = {}, date = new Date()) =>
  JSON.stringify({ timestamp: date.toISOString(), level, message, ...fields })

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

/** Effect's logs as Plat5 lines: the message's strings, the log's annotations its fields. */
export const logger = Logger.make<unknown, void>(({ cause, date, fiber, logLevel, message }) => {
  const parts = Array.isArray(message) ? message : [message]
  const fields: Record<string, unknown> = { ...fiber.getRef(References.CurrentLogAnnotations) }
  if (cause.reasons.length > 0 && !("error_message" in fields)) {
    fields.error_message = String(Cause.squash(cause))
  }
  console.log(line(levels[logLevel], parts.filter(Predicate.isString).join(" "), fields, date))
})

/** A telemetry failure, a failed export say, as its `error` line. */
export const telemetryError = (message: string) =>
  Effect.logError("telemetry error").pipe(Effect.annotateLogs({ error_message: message }))

/** Every log in Plat5's lines, in place of Effect's own. */
export const layer = Logger.layer([logger])
