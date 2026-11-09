import { expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { TaskCreate, TaskUpdate } from "../domain/Task.js"
import { FALLBACK_VALIDATION } from "./Errors.js"
import { isJson, parseOptions, validationFailed } from "./Request.js"

/** The fields a body's 422 lists, or the decoded body. */
const check = (schema: Schema.Top & { readonly DecodingServices: never }, body: unknown) => {
  const result = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(schema, parseOptions.payload)(body)))
  return Result.isSuccess(result) ? { ok: result.success } : { fields: validationFailed(result.failure.issue).fields }
}

test("a body's values: each wrong one at its path, with its schema's sentence", () => {
  expect(check(TaskCreate, { title: "  Ship  " })).toEqual({ ok: { title: "Ship" } })
  expect(check(TaskCreate, {})).toEqual({ fields: [{ path: "title", message: "Title is required." }] })
  expect(check(TaskCreate, { title: " \n " })).toEqual({ fields: [{ path: "title", message: "Title is required." }] })
  expect(check(TaskCreate, { title: "é".repeat(255) })).toEqual({ ok: { title: "é".repeat(255) } })
  expect(check(TaskCreate, { title: "😀".repeat(256) })).toEqual({
    fields: [{ path: "title", message: "Title is too long." }]
  })
  expect(check(TaskCreate, { title: 1, status: "nope", assignee_id: "bad" })).toEqual({
    fields: [
      { path: "title", message: FALLBACK_VALIDATION },
      { path: "status", message: "Status must be todo, in progress, or done." },
      { path: "assignee_id", message: FALLBACK_VALIDATION }
    ]
  })
  expect(check(TaskUpdate, { title: " ", status: null })).toEqual({
    fields: [{ path: "title", message: "Title is required." }]
  })
})

test("a body's unknown keys: refused alone, each `<path> isn't a field.`, before any value", () => {
  expect(check(TaskCreate, { Title: "T", title: 1, address: { street: 1 } })).toEqual({
    fields: [
      { path: "Title", message: "Title isn't a field." },
      { path: "address", message: "address isn't a field." }
    ]
  })
})

test("a body that isn't an object is a 422 at body", () => {
  for (const body of [[], "title", 1, null]) {
    expect(check(TaskCreate, body)).toEqual({ fields: [{ path: "body", message: FALLBACK_VALIDATION }] })
  }
})

test("isJson: application/json with any parameters, nothing else", () => {
  expect(isJson("application/json")).toBe(true)
  expect(isJson("Application/JSON; charset=utf-8")).toBe(true)
  for (const type of [undefined, "", "text/plain", "application/merge-patch+json", "application/jsonx"]) {
    expect(isJson(type)).toBe(false)
  }
})
