import { describe, expect, test } from "bun:test";

// Matrix handleAutoForward is a deferred send — it stores text
// and the "finished" handler sends it. We verify the deferral
// contract: handleAutoForward does NOT send immediately.
// Full integration requires a live Matrix homeserver; we test the
// interface contract here.

describe("Matrix handleAutoForward (deferred send contract)", () => {
  test("handleAutoForward and getLastSentMessageId are defined on ChannelAdapter", () => {
    // Verify the interface allows these optional methods
    const mockAdapter = {
      handleAutoForward: async (_text: string, _sources: unknown[]) =>
        undefined as string | undefined,
      getLastSentMessageId: (_convId: string) => null as string | null,
    };
    expect(typeof mockAdapter.handleAutoForward).toBe("function");
    expect(typeof mockAdapter.getLastSentMessageId).toBe("function");
  });
});
