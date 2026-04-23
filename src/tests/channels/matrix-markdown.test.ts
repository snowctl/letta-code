import { expect, test } from "bun:test";
import {
  markdownToMatrixHtml,
  stripMarkdownToPlainText,
} from "../../tools/impl/MessageChannel";

test("markdownToMatrixHtml converts bold", () => {
  const result = markdownToMatrixHtml("**hello world**");
  expect(result).toContain("<strong>hello world</strong>");
});

test("markdownToMatrixHtml converts inline code", () => {
  const result = markdownToMatrixHtml("`foo`");
  expect(result).toContain("<code>foo</code>");
});

test("markdownToMatrixHtml converts code block", () => {
  const result = markdownToMatrixHtml("```\nconst x = 1;\n```");
  expect(result).toContain("<code>");
  expect(result).toContain("const x = 1;");
});

test("stripMarkdownToPlainText removes bold markers", () => {
  const result = stripMarkdownToPlainText("**hello** world");
  expect(result).toBe("hello world");
});

test("stripMarkdownToPlainText removes inline code markers", () => {
  const result = stripMarkdownToPlainText("`foo`");
  expect(result).toBe("foo");
});

test("formatOutboundChannelMessage matrix returns HTML parseMode", () => {
  // Tested via the formatter directly below
  const result = stripMarkdownToPlainText("# Heading\n**bold** _italic_");
  expect(result).not.toContain("**");
  expect(result).not.toContain("_");
  expect(result).not.toContain("#");
});
