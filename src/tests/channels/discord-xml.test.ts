import { describe, expect, test } from "bun:test";
import type { InboundChannelMessage } from "../../channels/types";
import {
  buildChannelMessageBody,
  buildChannelReminderText,
} from "../../channels/xml";

describe("discord envelope", () => {
  test("reminder lists Channel: discord in metadata", () => {
    const message: InboundChannelMessage = {
      channel: "discord",
      chatId: "channel-123",
      senderId: "user-1",
      senderName: "alice",
      messageId: "msg-1",
      text: "hello discord",
      timestamp: Date.now(),
    };
    const reminder = buildChannelReminderText(message);
    expect(reminder).toContain("- **Channel**: discord");
    expect(reminder).toContain("- **Chat ID**: channel-123");
    expect(reminder).toContain("- **Message ID**: msg-1");
  });

  test("reminder includes a react directive with discord-specific custom-emoji syntax", () => {
    const message: InboundChannelMessage = {
      channel: "discord",
      chatId: "channel-123",
      senderId: "user-1",
      senderName: "alice",
      messageId: "msg-1",
      text: "hey",
      timestamp: Date.now(),
    };
    const reminder = buildChannelReminderText(message);
    expect(reminder).toContain("**React without text**");
    expect(reminder).toContain('action="react"');
    expect(reminder).toContain("custom emoji syntax like `<:name:id>`");
  });

  test("threadId is recorded in chat metadata", () => {
    const message: InboundChannelMessage = {
      channel: "discord",
      chatId: "channel-123",
      senderId: "user-1",
      senderName: "alice",
      messageId: "msg-1",
      text: "in a thread",
      threadId: "thread-999",
      timestamp: Date.now(),
    };
    const reminder = buildChannelReminderText(message);
    expect(reminder).toContain("- **Thread ID**: thread-999");
  });

  test("thread context renders <thread-context>/<thread-starter>/<thread-history> in the body, before the user text", () => {
    const message: InboundChannelMessage = {
      channel: "discord",
      chatId: "channel-123",
      senderId: "user-1",
      senderName: "alice",
      messageId: "msg-1",
      text: "replying in thread",
      threadId: "thread-999",
      timestamp: Date.now(),
      threadContext: {
        label: "Project Questions",
        starter: {
          messageId: "msg-0",
          senderId: "user-0",
          senderName: "bob",
          text: "How should we handle retries?",
        },
        history: [
          {
            messageId: "msg-0a",
            senderId: "user-2",
            senderName: "carol",
            text: "I'd exponential-backoff.",
          },
        ],
      },
    };
    const body = buildChannelMessageBody(message);
    expect(body).toContain("<thread-context");
    expect(body).toContain("<thread-starter");
    expect(body).toContain("<thread-history>");
    expect(body.endsWith("replying in thread")).toBe(true);
  });

  test("reaction events surface in the chat-context section, not in the body", () => {
    const message: InboundChannelMessage = {
      channel: "discord",
      chatId: "channel-123",
      senderId: "user-1",
      senderName: "alice",
      messageId: "msg-1",
      text: "",
      timestamp: Date.now(),
      reaction: {
        action: "added",
        emoji: "🔥",
        targetMessageId: "msg-1",
      },
    };
    const reminder = buildChannelReminderText(message);
    const body = buildChannelMessageBody(message);

    expect(reminder).toContain("**Reaction event**");
    expect(reminder).toContain("alice added `🔥` on message `msg-1`");
    expect(body).toBe("");
  });
});
