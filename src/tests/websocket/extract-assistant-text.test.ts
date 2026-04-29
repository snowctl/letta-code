import { describe, expect, test } from "bun:test";
import { extractAssistantText } from "../../websocket/listener/turn";

describe("extractAssistantText", () => {
  test("returns null for non-assistant_message types", () => {
    expect(extractAssistantText({ message_type: "tool_call_message" })).toBeNull();
    expect(extractAssistantText({ message_type: "reasoning_message" })).toBeNull();
    expect(extractAssistantText({ message_type: "tool_return_message" })).toBeNull();
  });

  test("extracts text from string content", () => {
    expect(
      extractAssistantText({ message_type: "assistant_message", content: "hello" })
    ).toBe("hello");
  });

  test("returns null for empty string content", () => {
    expect(
      extractAssistantText({ message_type: "assistant_message", content: "" })
    ).toBeNull();
  });

  test("concatenates text blocks from array content", () => {
    expect(
      extractAssistantText({
        message_type: "assistant_message",
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
      })
    ).toBe("hello world");
  });

  test("returns null for empty array content", () => {
    expect(
      extractAssistantText({ message_type: "assistant_message", content: [] })
    ).toBeNull();
  });

  test("ignores non-text content blocks", () => {
    expect(
      extractAssistantText({
        message_type: "assistant_message",
        content: [
          { type: "image_url", url: "http://example.com/img.png" },
          { type: "text", text: "caption" },
        ],
      })
    ).toBe("caption");
  });
});
