import { describe, expect, test } from "bun:test";
import { channel_action } from "../../tools/impl/ChannelAction";

// Helper: a fake registry that has no active turn context
function fakeEmptyRegistry() {
  return {
    getActiveTurnContext: (_convId: string) => null,
    getLastSentMessageId: (_ch: string, _acc: unknown, _convId: string) => null,
    getRouteForScope: (
      _ch: string,
      _chatId: string,
      _agentId: string,
      _convId: string,
    ) => null,
    getAdapter: (_ch: string, _acc: unknown) => null,
  } as unknown as import("../../channels/registry").ChannelRegistry;
}

// Helper: a fake registry that has active turn context + optional action handler
function fakeRegistryWithContext(opts: {
  conversationId: string;
  source: {
    channel: string;
    chatId: string;
    messageId?: string;
    threadId?: string;
    accountId?: string;
    agentId: string;
    conversationId: string;
  };
  lastSentMessageId?: string | null;
  onAction: (req: unknown) => string | Promise<string>;
}) {
  const { source, onAction, lastSentMessageId } = opts;
  return {
    getActiveTurnContext: (convId: string) =>
      convId === opts.conversationId ? source : null,
    getLastSentMessageId: (_ch: string, _acc: unknown, _convId: string) =>
      lastSentMessageId ?? null,
    getRouteForScope: (
      ch: string,
      chatId: string,
      agentId: string,
      convId: string,
    ) => {
      if (
        ch === source.channel &&
        chatId === source.chatId &&
        agentId === source.agentId &&
        convId === source.conversationId
      ) {
        return {
          channelId: ch,
          chatId,
          agentId,
          conversationId: convId,
          accountId: source.accountId,
          enabled: true,
        };
      }
      return null;
    },
    getAdapter: (_ch: string, _acc: unknown) => ({
      isRunning: () => true,
    }),
  } as unknown as import("../../channels/registry").ChannelRegistry;
}

describe("channel_action — context resolution", () => {
  test("returns error when no active turn context for conversationId", async () => {
    const result = await channel_action(
      { action: "react", emoji: "👍" },
      {
        parentScope: { agentId: "a", conversationId: "c-no-context" },
        registry: fakeEmptyRegistry(),
      },
    );
    expect(result).toContain("No active turn context");
  });
});

describe("channel_action — edit", () => {
  test("returns error when no last sent message id exists", async () => {
    const result = await channel_action(
      { action: "edit", text: "Updated text" },
      {
        parentScope: { agentId: "a", conversationId: "c1" },
        registry: fakeRegistryWithContext({
          conversationId: "c1",
          source: {
            channel: "telegram",
            chatId: "555",
            agentId: "a",
            conversationId: "c1",
          },
          lastSentMessageId: null,
          onAction: () => "ok",
        }),
      },
    );
    expect(result).toContain("No previous message to edit");
  });
});
