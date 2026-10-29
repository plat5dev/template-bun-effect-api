import { expect, test } from "bun:test"
import { Effect, Either } from "effect"
import { anything, arrayOf, charLength, checkKeys, isJson, object, recordOf, trimSpace, unknownFields } from "./Body.js"
import { now } from "./Clock.js"

test("trimSpace trims Unicode white space, as Go's strings.TrimSpace", () => {
  expect(trimSpace(" \t\n \u0085 　a b  ")).toBe("a b")
  // U+FEFF isn't white space to Go, though JavaScript's trim takes it.
  expect(trimSpace("﻿a﻿")).toBe("﻿a﻿")
})

test("charLength counts characters", () => {
  expect(charLength("é😀")).toBe(2)
})

test("isJson: the media type before ';', lowercased and trimmed", () => {
  for (const type of ["application/json", " Application/JSON ; charset=utf-8", "application/problem+json"]) {
    expect(isJson(type)).toBe(true)
  }
  for (const type of [undefined, "", "text/json", "application/jsonx", "application/+jsonx", "json"]) {
    expect(isJson(type)).toBe(false)
  }
})

test("now is RFC 3339 UTC without the fraction's trailing zeros", () => {
  expect(now(new Date("2026-10-28T00:00:00.000Z"))).toBe("2026-10-28T00:00:00Z")
  expect(now(new Date("2026-10-28T00:00:10.120Z"))).toBe("2026-10-28T00:00:10.12Z")
  expect(now(new Date("2026-10-28T00:00:00.007Z"))).toBe("2026-10-28T00:00:00.007Z")
})

const tag = object({ name: anything })
const shape = object({
  title: anything,
  raw: anything,
  address: object({ street: anything }),
  tags: arrayOf(tag),
  meta: recordOf(anything),
  by_name: recordOf(tag)
})

test("unknownFields: keys match exactly, in the body's order, each once", () => {
  for (
    const [json, paths] of [
      [
        `{"title":"T","raw":{"Anything":[{"x":1}]},"address":{"street":"Main"},"tags":[{"name":"a"},{"name":"b"}],"meta":{"Free":{"Form":1}},"by_name":{"k":{"name":"c"}}}`,
        []
      ],
      [`null`, []],
      [`[{"x":1}]`, []],
      [`{"Title":"T"}`, ["Title"]],
      [`{"title":"T","extra":1}`, ["extra"]],
      [`{"b":1,"title":"T","a":2}`, ["b", "a"]],
      // Integer keys keep their place, which JSON.parse's objects don't.
      [`{"b":1,"2":2,"1":3}`, ["b", "2", "1"]],
      [`{"address":{"Street":"Main"}}`, ["address.Street"]],
      [`{"tags":[{"name":"a"},{"Name":"b","x":1}]}`, ["tags[1].Name", "tags[1].x"]],
      [`{"by_name":{"k":{"nope":1}}}`, ["by_name.k.nope"]],
      [`{"Title":5,"zzz":true}`, ["Title", "zzz"]],
      [`{"x":1,"title":"T","y":2,"x":3}`, ["x", "y"]],
      [` { "a b" : "}\\\"", "t\\u0069tle" : [ 1 , { } ] , "\\ud800" : 1 } `, ["a b", "\ufffd"]],
      // A value of the wrong shape isn't walked: its type is checked after the keys.
      [`{"address":[{"x":1}],"tags":{"x":1}}`, []]
    ] as const
  ) {
    expect(unknownFields(json, shape), json).toEqual([...paths])
  }
})

test("checkKeys: a 422 listing each unknown field, the first one's sentence the message", () => {
  expect(Either.isRight(Effect.runSync(Effect.either(checkKeys(`{"title":"T"}`, shape))))).toBe(true)
  const result = Effect.runSync(Effect.either(checkKeys(`{"Title":"T","address":{"Street":1}}`, shape)))
  expect(Either.isLeft(result) && result.left).toEqual({
    error: {
      type: "invalid_request_error",
      code: "VALIDATION_ERROR",
      message: "Title isn't a field.",
      request_id: null,
      details: {
        fields: [
          { path: "Title", message: "Title isn't a field." },
          { path: "address.Street", message: "address.Street isn't a field." }
        ]
      }
    }
  })
})
