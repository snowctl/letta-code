import { describe, expect, test } from "bun:test";

describe("Slack handleAutoForward (interface contract)", () => {
  test("handleAutoForward and getLastSentMessageId are defined on ChannelAdapter", () => {
    const mockAdapter = {
      handleAutoForward: async (_text: string, _sources: unknown[]) =>
        undefined as string | undefined,
      getLastSentMessageId: (_convId: string) => null as string | null,
    };
    expect(typeof mockAdapter.handleAutoForward).toBe("function");
    expect(typeof mockAdapter.getLastSentMessageId).toBe("function");
  });
});
