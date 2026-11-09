import { Effect, Exit, Metric } from "effect"

const dbAttributes = { db_system_name: "sqlite", db_namespace: "api" } as const

const dbOperations = Metric.counter("db_operations_total", {
  description: "Total database operations",
  attributes: dbAttributes,
  incremental: true
})

const dbErrors = Metric.counter("db_operation_errors_total", {
  description: "Total failed database operations",
  attributes: dbAttributes,
  incremental: true
})

const dbDuration = Metric.histogram("db_operation_duration_seconds", {
  description: "Database operation duration in seconds",
  attributes: dbAttributes,
  boundaries: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
})

/** Wrap a repo effect: total + duration always; errors on failure. */
export const trackDb = (operationName: string) => {
  const attributes = { db_operation_name: operationName }
  const operations = Metric.withAttributes(dbOperations, attributes)
  const errors = Metric.withAttributes(dbErrors, attributes)
  const duration = Metric.withAttributes(dbDuration, attributes)
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function*() {
      const started = performance.now()
      const exit = yield* Effect.exit(effect)
      yield* Metric.update(operations, 1)
      yield* Metric.update(duration, (performance.now() - started) / 1000)
      if (Exit.isFailure(exit)) {
        yield* Metric.update(errors, 1)
      }
      return yield* exit
    })
}
