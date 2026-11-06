import type { Meter } from "@opentelemetry/api"

/** Minimum process metrics per plat5 docs/reference/telemetry.md, on `meter`. */
export const registerProcessMetrics = (meter: Meter): void => {
  const startTime = Date.now() / 1000 - process.uptime()

  meter
    .createObservableGauge("process_resident_memory_bytes", {
      description: "Resident memory size in bytes",
      unit: "By"
    })
    .addCallback((result) => {
      result.observe(process.memoryUsage().rss)
    })

  meter
    .createObservableCounter("process_cpu_seconds_total", {
      description: "Total user and system CPU time spent in seconds",
      unit: "s"
    })
    .addCallback((result) => {
      const usage = process.cpuUsage()
      result.observe((usage.user + usage.system) / 1_000_000)
    })

  meter
    .createObservableGauge("process_start_time_seconds", {
      description: "Start time of the process since unix epoch in seconds",
      unit: "s"
    })
    .addCallback((result) => {
      result.observe(startTime)
    })
}
