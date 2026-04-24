import { afterEach, describe, expect, mock, test } from "bun:test";
import { ChannelRegistry, getChannelRegistry } from "../../channels/registry";
import type { ChannelAdapter, ChannelTurnSource } from "../../channels/types";

afterEach(async () => {
  const registry = getChannelRegistry();
  if (registry) {
    await registry.stopAll();
  }
});

function makeSource(chatId: string): ChannelTurnSource {
  return {
    channel: "telegram" as const,
    accountId: "acc-1",
    chatId,
    agentId: "agent-1",
    conversationId: "conv-1",
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
    handleStreamText: mock(async () => {}),
  };
}

describe("ChannelRegistry.dispatchStreamText", () => {
  test("calls handleStreamText on the matching adapter with grouped sources", async () => {
    const registry = new ChannelRegistry();
    const adapter = makeMockAdapter();
    registry.registerAdapter(adapter);

    const sources = [makeSource("chat-1"), makeSource("chat-2")];
    await registry.dispatchStreamText("hello world", sources);

    expect(adapter.handleStreamText).toHaveBeenCalledTimes(1);
    expect(adapter.handleStreamText).toHaveBeenCalledWith("hello world", sources);
  });

  test("skips adapters without handleStreamText", async () => {
    const registry = new ChannelRegistry();
    const adapter = makeMockAdapter();
    (adapter as Partial<ChannelAdapter>).handleStreamText = undefined;
    registry.registerAdapter(adapter);

    await expect(
      registry.dispatchStreamText("hello", [makeSource("chat-1")])
    ).resolves.toBeUndefined();
  });

  test("catches adapter errors without rethrowing", async () => {
    const registry = new ChannelRegistry();
    const adapter = makeMockAdapter();
    (adapter.handleStreamText as ReturnType<typeof mock>).mockImplementation(
      async () => { throw new Error("API down"); }
    );
    registry.registerAdapter(adapter);

    await expect(
      registry.dispatchStreamText("hello", [makeSource("chat-1")])
    ).resolves.toBeUndefined();
  });
});
