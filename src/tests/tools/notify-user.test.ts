import { describe, expect, test } from "bun:test";
import type { ChannelRegistry } from "../../channels/registry";
import { notify_user } from "../../tools/impl/NotifyUser";

function fakeEmptyRegistry() {
  return {
    getRouteForScope: () => null,
    getAdapter: () => null,
  } as unknown as ChannelRegistry;
}

describe("notify_user", () => {
  test("returns error when scope is missing", async () => {
    const result = await notify_user(
      { channel: "telegram", chat_id: "123", message: "Hello" },
      { registry: fakeEmptyRegistry() },
    );
    expect(result).toContain("requires execution scope");
  });

  test("returns error when no route found", async () => {
    const result = await notify_user(
      { channel: "telegram", chat_id: "no-such-chat", message: "Hi" },
      {
        parentScope: { agentId: "a", conversationId: "c1" },
        registry: fakeEmptyRegistry(),
      },
    );
    expect(result).toContain("No route");
  });
});
