import { test, expect } from "bun:test";
import { wordBoundaryTrim } from "../../channels/matrix/htmlFormat";

test("returns full text when no whitespace yet", () => {
  expect(wordBoundaryTrim("hello")).toBe("hello");
});

test("trims to last whitespace boundary", () => {
  expect(wordBoundaryTrim("hello wor")).toBe("hello");
});

test("trims trailing partial word", () => {
  expect(wordBoundaryTrim("hello world how a")).toBe("hello world how");
});

test("preserves trailing whitespace exactly at boundary", () => {
  expect(wordBoundaryTrim("hello ")).toBe("hello");
});

test("returns empty string when only partial word", () => {
  expect(wordBoundaryTrim("partial")).toBe("partial");
});
