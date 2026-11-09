import { expect, onTestFinished, spyOn, test } from "bun:test"
import { Effect, Exit, Layer, Scope } from "effect"
import { TelemetryLive } from "./Telemetry.js"
import { envLayer } from "./testing.js"

/** A collector, keeping each request's path and headers. */
const serveCollector = () => {
  const got: Array<{ path: string; headers: Headers }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      got.push({ path: new URL(req.url).pathname, headers: req.headers })
      return new Response(null, { status: 200 })
    }
  })
  onTestFinished(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, got }
}

/** Runs ten traced requests' worth of spans under TelemetryLive with `env`, then shuts down (which flushes). */
const traceWith = async (env: Record<string, string>) => {
  const logs = spyOn(console, "log").mockImplementation(() => {})
  onTestFinished(() => logs.mockRestore())
  const scope = Effect.runSync(Scope.make())
  const context = await Effect.runPromise(Layer.buildWithScope(TelemetryLive, scope).pipe(Effect.provide(envLayer(env))))
  for (let i = 0; i < 10; i++) {
    await Effect.runPromise(Effect.void.pipe(Effect.withSpan(`span ${i}`), Effect.provide(context)))
  }
  await Effect.runPromise(Scope.close(scope, Exit.void))
  return logs.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
}

test("with a destination, spans are pushed over OTLP/HTTP protobuf, with the configured headers", async () => {
  const collector = serveCollector()
  await traceWith({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.url}/v1/traces`, OTEL_EXPORTER_OTLP_HEADERS: "x-auth=s%20t" })
  const traces = collector.got.filter((r) => r.path === "/v1/traces")
  expect(traces.length).toBeGreaterThan(0)
  expect(traces[0]!.headers.get("content-type")).toBe("application/x-protobuf")
  expect(traces[0]!.headers.get("x-auth")).toBe("s t")
})

test("OTEL_TRACES_SAMPLER_RATIO 0 samples no new trace", async () => {
  const collector = serveCollector()
  await traceWith({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.url}/v1/traces`, OTEL_TRACES_SAMPLER_RATIO: "0" })
  expect(collector.got.filter((r) => r.path === "/v1/traces")).toEqual([])
})

test("a failed export is a JSON error line; the API keeps serving", async () => {
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const url = `http://127.0.0.1:${closed.port}/v1/traces`
  await closed.stop(true)
  const lines = await traceWith({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: url })
  const failed = lines.find((line) => line.message === "telemetry error")
  expect(failed).toMatchObject({ level: "error" })
  expect(typeof failed?.error_message).toBe("string")
})
