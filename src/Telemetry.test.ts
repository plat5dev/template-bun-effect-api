import { diag, DiagLogLevel } from "@opentelemetry/api"
import { expect, onTestFinished, spyOn, test } from "bun:test"
import { diagLogger } from "./Telemetry.js"

// A failed export reaches OpenTelemetry's diagnostic logger, which writes one JSON line.
test("a failed export is one JSON error line", () => {
  // Another test file may have registered a logger; replacing one logs warnings of its own.
  diag.disable()
  const logs = spyOn(console, "log").mockImplementation(() => {})
  diag.setLogger(diagLogger, DiagLogLevel.WARN)
  onTestFinished(() => {
    diag.disable()
    logs.mockRestore()
  })

  diag.error("traces export: connection refused")

  expect(logs).toHaveBeenCalledTimes(1)
  const line = JSON.parse(String(logs.mock.calls[0]?.[0]))
  expect(line).toMatchObject({
    level: "error",
    message: "telemetry error",
    error_message: "traces export: connection refused"
  })
  expect(typeof line.timestamp).toBe("string")
})
