import { test, expect } from "bun:test";
import { streamingMarkdownToHtml } from "../../channels/matrix/htmlFormat";

test("plain text passes through", () => {
  const r = streamingMarkdownToHtml("hello world");
  expect(r.html).toContain("hello world");
});

test("unclosed triple-fence is closed before rendering", () => {
  const r = streamingMarkdownToHtml("here:\n```ts\nconst x = 1");
  // Should render as a code block, not as raw markdown.
  expect(r.html).toContain("<code");
  expect(r.html).not.toContain("```");
});

test("unclosed inline backtick is closed", () => {
  const r = streamingMarkdownToHtml("call `foo");
  expect(r.html).toContain("<code>foo</code>");
});

test("unclosed bold is closed", () => {
  const r = streamingMarkdownToHtml("this is **bold and unfinished");
  expect(r.html).toContain("<strong>");
});

test("trailing partial link [foo](http is stripped", () => {
  const r = streamingMarkdownToHtml("see [docs](http");
  // Either rendered as plaintext or stripped — not as a broken anchor.
  expect(r.html).not.toContain("<a ");
  expect(r.text).toContain("see");
});

test("trailing partial HTML tag is stripped", () => {
  const r = streamingMarkdownToHtml("hello <");
  expect(r.text).toContain("hello");
  expect(r.html).not.toContain("<<");
});

test("balanced markdown renders normally", () => {
  const r = streamingMarkdownToHtml("**bold** and `code`");
  expect(r.html).toContain("<strong>bold</strong>");
  expect(r.html).toContain("<code>code</code>");
});

test("unclosed underscore-italic is closed", () => {
  const r = streamingMarkdownToHtml("this is _italic and unfinished");
  expect(r.html).toContain("<em>");
});
