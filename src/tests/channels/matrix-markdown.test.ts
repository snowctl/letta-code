import { expect, test } from "bun:test";
import {
  markdownToMatrixHtml,
  stripMarkdownToPlainText,
} from "../../channels/format";

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

test("stripMarkdownToPlainText removes fenced code block markers", () => {
  const result = stripMarkdownToPlainText("```js\nconst x = 1;\n```");
  expect(result).not.toContain("```");
  expect(result).toContain("const x = 1;");
});

test("stripMarkdownToPlainText removes heading and emphasis markers", () => {
  const result = stripMarkdownToPlainText("# Heading\n**bold** _italic_");
  expect(result).not.toContain("**");
  expect(result).not.toContain("_");
  expect(result).not.toContain("#");
});
