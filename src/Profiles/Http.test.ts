import { BunHttpServer } from "@effect/platform-bun"
import { expect, onTestFinished, spyOn, test } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpServer } from "effect/http"
import { PublicApiLive } from "../Http.js"
import { DETAILS_HEADER } from "../plat5/Audit.js"
import { TelemetryLive } from "../Telemetry.js"
import { envLayer } from "../testing.js"

const user = "01jd8x3k7q00000000000000u1"
const profilePath = `/users/${user}/profile`
const FALLBACK = "That doesn't look right."

/** The public API on a port of its own, and a way to send it a profile's body. */
const newApp = async () => {
  const logs = spyOn(console, "log").mockImplementation(() => {})
  const scope = Effect.runSync(Scope.make())
  onTestFinished(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    logs.mockRestore()
  })
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      PublicApiLive.pipe(
        Layer.provideMerge(BunHttpServer.layer({ port: 0, hostname: "127.0.0.1" })),
        Layer.provide(TelemetryLive)
      ),
      scope
    ).pipe(
      Effect.provide(envLayer(new Map([["DATABASE_PATH", ":memory:"], ["TASK_ASSIGNEE_PERMISSION", "x"]]))
      )
    )
  )
  const { address } = Context.get(context, HttpServer.HttpServer)
  const base = `http://127.0.0.1:${"port" in address ? address.port : 0}`
  return (method: "GET" | "PUT", body?: string, contentType: string | null = "application/json") =>
    fetch(`${base}${profilePath}`, {
      method,
      body,
      headers: body === undefined || contentType === null ? {} : { "content-type": contentType }
    })
}

const expectField = async (res: Response, path: string, message: string) => {
  expect(res.status).toBe(422)
  const { error } = (await res.json()) as { error: { code: string; message: string; details: unknown } }
  expect(error.code).toBe("VALIDATION_ERROR")
  expect(error.message).toBe(message)
  expect(error.details).toEqual({ fields: [{ path, message }] })
}

test("bio: required, at most 2000 characters, kept as sent", async () => {
  const send = await newApp()
  await expectField(await send("PUT", `{}`), "bio", "Bio is required.")
  await expectField(await send("PUT", `{"bio":null}`), "bio", FALLBACK)
  await expectField(await send("PUT", JSON.stringify({ bio: "é".repeat(2001) })), "bio", "Bio is too long.")
  for (const bio of ["😀".repeat(2000), "  spaced  ", ""]) {
    const res = await send("PUT", JSON.stringify({ bio }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { bio: string }).bio).toBe(bio)
  }
})

test("a profile body not sent as JSON, empty, or not JSON is a 400; of the wrong shape, a 422", async () => {
  const send = await newApp()
  for (const [body, contentType] of [
    [`{"bio":"hi"}`, null],
    [`{"bio":"hi"}`, "text/plain"],
    ["", "application/json"],
    ["{", "application/json"]
  ] as const) {
    const res = await send("PUT", body, contentType)
    expect(res.status, `${contentType} ${body}`).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_REQUEST")
  }
  await expectField(await send("PUT", `{"bio":5}`), "bio", FALLBACK)
  await expectField(await send("PUT", `["hi"]`), "body", FALLBACK)
  // Nothing was written: the profile is still new.
  const res = await send("GET")
  expect(((await res.json()) as { bio: string }).bio).toBe("")
})

test("PUT: keys match exactly: an unknown field is a 422 naming each", async () => {
  const send = await newApp()
  for (
    const [body, paths] of [
      [`{"Bio":"hi"}`, ["Bio"]],
      [`{"bio":"hi","name":"x"}`, ["name"]],
      // Before any value: the type and the length are checked once the keys are right.
      [`{"BIO":5,"bio":${JSON.stringify("x".repeat(2001))}}`, ["BIO"]]
    ] as const
  ) {
    const res = await send("PUT", body)
    expect(res.status, body).toBe(422)
    const { error } = (await res.json()) as { error: { code: string; message: string; details: { fields: unknown } } }
    expect(error.code, body).toBe("VALIDATION_ERROR")
    expect(error.message, body).toBe(`${paths[0]} isn't a field.`)
    expect(error.details.fields, body).toEqual(paths.map((path) => ({ path, message: `${path} isn't a field.` })))
  }
  // Nothing was written: the profile is still new.
  const res = await send("GET")
  expect(((await res.json()) as { bio: string }).bio).toBe("")
  expect((await send("PUT", `{"bio":"hi"}`)).status).toBe(200)
})

test("PUT is 200 whether the profile is new or not, with the change audited", async () => {
  const send = await newApp()
  let res = await send("PUT", `{"bio":""}`)
  expect(res.status).toBe(200)
  expect(res.headers.get(DETAILS_HEADER)).toBe(`{"bio":{"from":null,"to":""}}`)
  res = await send("PUT", `{"bio":"<hi>"}`)
  expect(res.status).toBe(200)
  expect(res.headers.get(DETAILS_HEADER)).toBe(`{"bio":{"from":"","to":"\\u003chi\\u003e"}}`)
  res = await send("PUT", `{"bio":"<hi>"}`)
  expect(res.headers.get(DETAILS_HEADER)).toBeNull()
  expect(res.headers.get("content-type")).toBe("application/json")
})
