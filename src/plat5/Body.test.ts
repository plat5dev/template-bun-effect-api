import { expect, test } from "bun:test"
import { charLength, isJson, trimSpace } from "./Body.js"
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
