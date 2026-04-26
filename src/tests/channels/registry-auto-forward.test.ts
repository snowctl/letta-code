import { afterEach, describe, expect, mock, test } from "bun:test";
import { ChannelRegistry, getChannelRegistry } from "../../channels/registry";
import type { ChannelAdapter, ChannelTurnSource } from "../../channels/types";

afterEach(async () => {
  const registry = getChannelRegistry();
  if (registry) {
    await registry.stopAll();
  }
});

function makeSource(
  chatId: string,
  conversationId = "conv-1",
  accountId = "acc-1",
): ChannelTurnSource {
  return {
    channel: "telegram" as const,
    accountId,
    chatId,
    agentId: "agent-1",
    conversationId,
  };
}

function makeMockAdapter(accountId = "acc-1"): ChannelAdapter {
  return {
    id: "test-adapter",
    channelId: "telegram" as const,
    accountId,
    name: "Test",
    start: mock(async () => {}),
    stop: mock(async () => {}),
    isRunning: mock(() => true),
    sendMessage: mock(async () => ({ messageId: "1" })),
    sendDirectReply: mock(async () => {}),
    handleAutoForward: mock(async () => undefined),
  };
}

describe("ChannelRegistry turn context", () => {
  test("setActiveTurnContext stores and getActiveTurnContext retrieves", () => {
    const registry = new ChannelRegistry();
    const source = makeSource("chat-1");
    registry.setActiveTurnContext("conv-1", source);
    expect(registry.getActiveTurnContext("conv-1")).toEqual(source);
  });

  test("clearActiveTurnContext removes the entry", () => {
    const registry = new ChannelRegistry();
    const source = makeSource("chat-1");
    registry.setActiveTurnContext("conv-1", source);
    registry.clearActiveTurnContext("conv-1");
    expect(registry.getActiveTurnContext("conv-1")).toBeNull();
  });

  test("getActiveTurnContext returns null for unknown conversationId", () => {
    const registry = new ChannelRegistry();
    expect(registry.getActiveTurnContext("no-such-conv")).toBeNull();
  });
});

describe("ChannelRegistry dispatchAutoForward", () => {
  test("calls handleAutoForward on matching adapter grouped by adapter", async () => {
    const registry = new ChannelRegistry();
    const adapter = makeMockAdapter();
    registry.registerAdapter(adapter);

    const sources = [makeSource("chat-1"), makeSource("chat-2")];
    await registry.dispatchAutoForward("Hello!", sources);

    expect(adapter.handleAutoForward).toHaveBeenCalledTimes(1);
    expect(adapter.handleAutoForward).toHaveBeenCalledWith("Hello!", sources);
  });

  test("skips adapters without handleAutoForward", async () => {
    const registry = new ChannelRegistry();
    const adapter = makeMockAdapter();
    (adapter as Partial<ChannelAdapter>).handleAutoForward = undefined;
    registry.registerAdapter(adapter);

    await expect(
      registry.dispatchAutoForward("Hello!", [makeSource("chat-1")]),
    ).resolves.toBeUndefined();
  });

  test("catches adapter errors without rethrowing", async () => {
    const registry = new ChannelRegistry();
    const adapter = makeMockAdapter();
    (adapter.handleAutoForward as ReturnType<typeof mock>).mockImplementation(
      async () => {
        throw new Error("network failure");
      },
    );
    registry.registerAdapter(adapter);

    await expect(
      registry.dispatchAutoForward("Hello!", [makeSource("chat-1")]),
    ).resolves.toBeUndefined();
  });

  test("dispatches to multiple adapters with separate sources", async () => {
    const registry = new ChannelRegistry();
    const adapterA = makeMockAdapter("acc-a");
    const adapterB = makeMockAdapter("acc-b");
    registry.registerAdapter(adapterA);
    registry.registerAdapter(adapterB);

    const sourceA = makeSource("chat-a", "conv-a", "acc-a");
    const sourceB = makeSource("chat-b", "conv-b", "acc-b");

    await registry.dispatchAutoForward("Hi!", [sourceA, sourceB]);

    expect(adapterA.handleAutoForward).toHaveBeenCalledTimes(1);
    expect(adapterA.handleAutoForward).toHaveBeenCalledWith("Hi!", [sourceA]);
    expect(adapterB.handleAutoForward).toHaveBeenCalledTimes(1);
    expect(adapterB.handleAutoForward).toHaveBeenCalledWith("Hi!", [sourceB]);
  });
});
