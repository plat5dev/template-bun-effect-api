import { Effect, Exit, Metric, MetricBoundaries } from "effect"

const dbDurationBoundaries = MetricBoundaries.fromIterable([
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1
])

const recordDbTotal = (operationName: string) =>
  Metric.counter("db_operations_total", {
    description: "Total database operations",
    incremental: true
  }).pipe(
    Metric.tagged("db_system_name", "sqlite"),
    Metric.tagged("db_operation_name", operationName),
    Metric.tagged("db_namespace", "app"),
    Metric.update(1)
  )

const recordDbError = (operationName: string) =>
  Metric.counter("db_operation_errors_total", {
    description: "Total failed database operations",
    incremental: true
  }).pipe(
    Metric.tagged("db_system_name", "sqlite"),
    Metric.tagged("db_operation_name", operationName),
    Metric.tagged("db_namespace", "app"),
    Metric.update(1)
  )

const recordDbDuration = (operationName: string, seconds: number) =>
  Metric.histogram(
    "db_operation_duration_seconds",
    dbDurationBoundaries,
    "Database operation duration in seconds"
  ).pipe(
    Metric.tagged("db_system_name", "sqlite"),
    Metric.tagged("db_operation_name", operationName),
    Metric.tagged("db_namespace", "app"),
    Metric.update(seconds)
  )

/** Wrap a repo effect: total + duration always; errors on failure. */
export const trackDb = (operationName: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function*() {
      const started = performance.now()
      const exit = yield* Effect.exit(effect)
      const seconds = (performance.now() - started) / 1000
      yield* recordDbTotal(operationName)
      yield* recordDbDuration(operationName, seconds)
      if (Exit.isFailure(exit)) {
        yield* recordDbError(operationName)
      }
      return yield* exit
    })
