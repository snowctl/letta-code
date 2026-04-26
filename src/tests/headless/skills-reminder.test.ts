import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { prependReminderPartsToContent } from "../../reminders/engine";

const SR_OPEN = "<system-reminder>";
const SR_CLOSE = "</system-reminder>";
const sr = (inner: string) => `${SR_OPEN}\n${inner}\n${SR_CLOSE}`;

describe("headless shared reminder content helpers", () => {
  test("prepends reminder text to string user content as parts array", () => {
    const result = prependReminderPartsToContent("hello", [
      { type: "text", text: "<skills>demo</skills>" },
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result[0]).toEqual({ type: "text", text: "<skills>demo</skills>" });
    expect(result[1]).toEqual({ type: "text", text: "hello" });
  });

  test("prepends reminder parts for multimodal user content", () => {
    const multimodal = [
      { type: "text", text: "what is in this image?" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
    ] as unknown as Exclude<MessageCreate["content"], string>;

    const result = prependReminderPartsToContent(
      multimodal as MessageCreate["content"],
      [{ type: "text", text: "<skills>demo</skills>" }],
    );

    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result[0]).toEqual({
      type: "text",
      text: "<skills>demo</skills>",
    });
    expect(result[1]).toEqual(multimodal[0]);
    expect(result[2]).toEqual(multimodal[1]);
  });

  test("merges multiple system-reminder reminder parts into one block", () => {
    const result = prependReminderPartsToContent("hello", [
      { type: "text", text: sr("session context") },
      { type: "text", text: sr("agent info") },
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result).toHaveLength(2);
    const merged = (result[0] as { type: string; text: string }).text;
    expect(merged).toContain(SR_OPEN);
    expect(merged).toContain("session context");
    expect(merged).toContain("agent info");
    expect(merged).toContain(SR_CLOSE);
    // Only one opening tag
    expect(merged.split(SR_OPEN).length).toBe(2);
    expect(result[1]).toEqual({ type: "text", text: "hello" });
  });

  test("merges system-reminder reminder parts with a system-reminder first content part (channel notification case)", () => {
    const imagePart = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "abc" },
    };
    const result = prependReminderPartsToContent(
      [
        { type: "text", text: sr("channel notification") },
        imagePart,
      ] as MessageCreate["content"],
      [
        { type: "text", text: sr("session context") },
        { type: "text", text: sr("agent info") },
      ],
    );

    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    // One merged text block + image
    expect(result).toHaveLength(2);
    const merged = (result[0] as { type: string; text: string }).text;
    expect(merged.split(SR_OPEN).length).toBe(2);
    expect(merged).toContain("session context");
    expect(merged).toContain("agent info");
    expect(merged).toContain("channel notification");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result[1] as any).toEqual(imagePart);
  });

  test("non-system-reminder parts stay separate from the merged block", () => {
    const result = prependReminderPartsToContent("hello", [
      { type: "text", text: sr("session context") },
      { type: "text", text: "<skills>demo</skills>" },
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    // merged SR block + skills block + user message
    expect(result).toHaveLength(3);
    const merged = (result[0] as { type: string; text: string }).text;
    expect(merged).toContain("session context");
    expect(merged).not.toContain("<skills>");
    expect(result[1]).toEqual({ type: "text", text: "<skills>demo</skills>" });
    expect(result[2]).toEqual({ type: "text", text: "hello" });
  });

  test("does not absorb a non-system-reminder first content part", () => {
    const result = prependReminderPartsToContent(
      [{ type: "text", text: "plain user message" }] as MessageCreate["content"],
      [{ type: "text", text: sr("session context") }],
    );
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result).toHaveLength(2);
    const merged = (result[0] as { type: string; text: string }).text;
    expect(merged).toContain("session context");
    expect(result[1]).toEqual({ type: "text", text: "plain user message" });
  });
});
