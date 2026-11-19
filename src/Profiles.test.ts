import { expect, test } from "bun:test"
import { DETAILS_HEADER } from "./plat5/Audit.js"
import { makeTestApp } from "./testing.js"

const user = "01jd8x3k7q00000000000000u1"
const profilePath = `/users/${user}/profile`

const newClient = () => {
  const app = makeTestApp()
  return (method: "GET" | "PUT", body?: string, contentType: string | null = "application/json") =>
    app.fetch(profilePath, {
      method,
      body,
      headers: body === undefined || contentType === null ? {} : { "content-type": contentType }
    })
}

const expectValidationField = async (res: Response, path: string, message?: string) => {
  expect(res.status).toBe(422)
  const { error } = (await res.json()) as {
    error: { code: string; message: string; details: { fields: Array<{ path: string; message: string }> } }
  }
  expect(error.code).toBe("VALIDATION_ERROR")
  expect(error.details.fields.map((f) => f.path)).toContain(path)
  if (message !== undefined) {
    expect(error.details.fields.find((f) => f.path === path)?.message).toBe(message)
  }
}

test("GET lazily creates an empty profile", async () => {
  const send = newClient()
  const res = await send("GET")
  expect(res.status).toBe(200)
  const profile = (await res.json()) as { user_id: string; bio: string; created_at: string; updated_at: string }
  expect(profile.user_id).toBe(user)
  expect(profile.bio).toBe("")
  expect(profile.created_at).toBe(profile.updated_at)
})

test("PUT validates bio (required, <= 2000 code points, exact whitespace preserved)", async () => {
  const send = newClient()
  await expectValidationField(await send("PUT", `{}`), "bio", "Bio is required.")
  await expectValidationField(await send("PUT", `{"bio":null}`), "bio")
  await expectValidationField(await send("PUT", JSON.stringify({ bio: "é".repeat(2001) })), "bio", "Bio is too long.")

  for (const bio of ["😀".repeat(2000), "  spaced  ", ""]) {
    const res = await send("PUT", JSON.stringify({ bio }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { bio: string }).bio).toBe(bio)
  }
})

test("malformed JSON / non-JSON content-type -> 400; wrong shape or unknown keys -> 422", async () => {
  const send = newClient()
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
  await expectValidationField(await send("PUT", `{"bio":5}`), "bio")
  await expectValidationField(await send("PUT", `["hi"]`), "body")
  await expectValidationField(await send("PUT", `{"bio":"hi","extra":1}`), "extra")

  // Nothing was written by invalid requests.
  expect(((await (await send("GET")).json()) as { bio: string }).bio).toBe("")
})

test("PUT emits X-Plat5-Audit-Details with visible ASCII (no HTML escaping) and omits on no-op", async () => {
  const send = newClient()

  let res = await send("PUT", `{"bio":""}`)
  expect(res.status).toBe(200)
  expect(res.headers.get(DETAILS_HEADER)).toBe(`{"bio":{"from":null,"to":""}}`)

  res = await send("PUT", JSON.stringify({ bio: "<hi é>" }))
  expect(res.status).toBe(200)
  expect(res.headers.get(DETAILS_HEADER)).toBe(`{"bio":{"from":"","to":"<hi \\u00e9>"}}`)

  // No-op: bio unchanged -> no audit header.
  res = await send("PUT", JSON.stringify({ bio: "<hi é>" }))
  expect(res.status).toBe(200)
  expect(res.headers.get(DETAILS_HEADER)).toBeNull()
})
