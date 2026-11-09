/** The minimum process metrics (plat5 docs/reference/telemetry.md#process-metrics-minimum), as Effect metrics. */
import { Effect, Metric } from "effect"

const residentMemory = Metric.gauge("process_resident_memory_bytes", { description: "Resident memory size in bytes" })

const cpuSeconds = Metric.counter("process_cpu_seconds_total", {
  description: "Total user and system CPU time spent in seconds",
  incremental: true
})

const startTime = Metric.gauge("process_start_time_seconds", {
  description: "Start time of the process since unix epoch in seconds"
})

const startedAt = Date.now() / 1000 - process.uptime()
let cpuCounted = 0

/** Brings the process metrics up to now: before a scrape, and on a timer for OTLP. */
export const updateProcessMetrics: Effect.Effect<void> = Effect.suspend(() => {
  const usage = process.cpuUsage()
  const cpu = (usage.user + usage.system) / 1_000_000
  const delta = cpu - cpuCounted
  cpuCounted = cpu
  return Effect.all([
    Metric.update(residentMemory, process.memoryUsage().rss),
    Metric.update(cpuSeconds, delta),
    Metric.update(startTime, startedAt)
  ], { discard: true })
})
