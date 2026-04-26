import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { InboundChannelMessage } from "../../channels/types";
import {
  buildChannelMessageBody,
  buildChannelReminderText,
  formatChannelNotification,
} from "../../channels/xml";

function expectTextParts(
  content: MessageCreate["content"],
  expectedCount: number,
): Array<{ type: "text"; text: string }> {
  expect(Array.isArray(content)).toBe(true);
  const parts = content as Array<{ type: "text"; text: string }>;
  expect(parts.length).toBe(expectedCount);
  return parts;
}

const FIXED_TS = Date.parse("2026-04-25T12:27:01Z");

describe("formatChannelNotification", () => {
  test("emits reminder + bare body, with the user's text outside any XML wrapper", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "12345",
      senderId: "67890",
      senderName: "John",
      text: "Hello from Telegram!",
      timestamp: FIXED_TS,
      messageId: "msg-42",
    };

    const content = formatChannelNotification(msg);
    const [reminderPart, bodyPart] = expectTextParts(content, 2);

    expect(reminderPart!.text).toContain("<system-reminder>");
    expect(reminderPart!.text).toContain("</system-reminder>");
    expect(reminderPart!.text).toContain("## Message Metadata");
    expect(reminderPart!.text).toContain("- **Channel**: telegram");
    expect(reminderPart!.text).toContain("- **Chat ID**: 12345");
    expect(reminderPart!.text).toContain("- **Sender**: John (67890)");
    expect(reminderPart!.text).toContain("- **Message ID**: msg-42");

    // The body part is the user's text *outside* any XML — no
    // <channel-notification> wrapping, no nested envelope.
    expect(bodyPart!.text).toBe("Hello from Telegram!");
    expect(bodyPart!.text).not.toContain("<channel-notification");
  });

  test("renders sectioned markdown with metadata, chat context, and response directives", () => {
    const msg: InboundChannelMessage = {
      channel: "matrix",
      chatId: "!room:server",
      senderId: "@alice:server",
      senderName: "Alice",
      text: "ping",
      timestamp: FIXED_TS,
    };
    const reminder = buildChannelReminderText(msg);

    expect(reminder).toContain("## Message Metadata");
    expect(reminder).toContain("## Chat Context");
    expect(reminder).toContain("## Response Directives");
    expect(reminder).toContain("- **Type**: Direct message");
  });

  test("Received at field uses the message timestamp, not wall-clock — same input produces same envelope", () => {
    const msg: InboundChannelMessage = {
      channel: "matrix",
      chatId: "!room:server",
      senderId: "@alice:server",
      text: "ping",
      timestamp: FIXED_TS,
    };
    const a = buildChannelReminderText(msg);
    // Sleep is unnecessary — we just rebuild from the same input. The point
    // of the assertion: nothing in the reminder depends on Date.now().
    const b = buildChannelReminderText(msg);
    expect(a).toBe(b);
    expect(a).toContain("2026-04-25T12:27:01.000Z");
  });

  test("response directives explain auto-forward model: text delivered automatically, ChannelAction for side-effects", () => {
    const msg: InboundChannelMessage = {
      channel: "matrix",
      chatId: "!room:server",
      senderId: "@alice:server",
      text: "ping",
      timestamp: FIXED_TS,
    };
    const reminder = buildChannelReminderText(msg);

    expect(reminder).toContain("delivered automatically");
    expect(reminder).toContain("ChannelAction");
    expect(reminder).toContain('action="react"');
    expect(reminder).toContain('action="edit"');
    expect(reminder).toContain('action="thread-reply"');
    expect(reminder).not.toContain("MessageChannel");
    expect(reminder).not.toContain("You MUST respond via");
  });

  test("response directives explain silence: produce no response text", () => {
    const msg: InboundChannelMessage = {
      channel: "matrix",
      chatId: "!room:server",
      senderId: "@alice:server",
      text: "ping",
      timestamp: FIXED_TS,
    };
    const reminder = buildChannelReminderText(msg);
    expect(reminder).toContain("produce no response text");
  });

  test("react directive uses unicode-emoji hint by default, name-emoji hint for slack, and custom-emoji hint for discord", () => {
    const matrix = buildChannelReminderText({
      channel: "matrix",
      chatId: "!room",
      senderId: "@a",
      text: "x",
      timestamp: FIXED_TS,
    });
    expect(matrix).toContain("a unicode emoji");

    const slack = buildChannelReminderText({
      channel: "slack",
      chatId: "C1",
      senderId: "U1",
      text: "x",
      timestamp: FIXED_TS,
    });
    expect(slack).toContain("a reaction name like `thumbsup` or `eyes`");

    const discord = buildChannelReminderText({
      channel: "discord",
      chatId: "1",
      senderId: "u1",
      text: "x",
      timestamp: FIXED_TS,
    });
    expect(discord).toContain("custom emoji syntax like `<:name:id>`");
  });

  test("Slack threading hint is added in the chat-context section for threaded channel messages", () => {
    const msg: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "ping",
      timestamp: FIXED_TS,
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      chatType: "channel",
    };
    const reminder = buildChannelReminderText(msg);

    expect(reminder).toContain("**Slack threading**");
    expect(reminder).toContain("stay in this thread automatically");
  });

  test("attachments appear in chat context with kind/local_path/mime metadata, and an inspect-attachments directive is emitted", () => {
    const msg: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "see image",
      timestamp: FIXED_TS,
      attachments: [
        {
          kind: "image",
          localPath: "/tmp/photo.heic",
          name: "photo.heic",
          mimeType: "image/heic",
        },
      ],
    };
    const reminder = buildChannelReminderText(msg);

    expect(reminder).toContain("- **Attachment**: kind=image");
    expect(reminder).toContain("local_path=/tmp/photo.heic");
    expect(reminder).toContain("mime_type=image/heic");
    expect(reminder).toContain("local file/image tools");
  });

  test("voice memo transcription is shown as a sub-bullet under the attachment line", () => {
    const msg: InboundChannelMessage = {
      channel: "telegram",
      chatId: "123",
      senderId: "456",
      text: "",
      timestamp: FIXED_TS,
      attachments: [
        {
          kind: "audio",
          localPath: "/tmp/voice.ogg",
          name: "voice.ogg",
          mimeType: "audio/ogg",
          transcription: "Hello, this is a voice memo test.",
        },
      ],
    };
    const reminder = buildChannelReminderText(msg);

    expect(reminder).toContain("- **Attachment**: kind=audio");
    expect(reminder).toContain(
      '  - Transcription: "Hello, this is a voice memo test."',
    );
  });

  test("reaction events are reported in chat context, not as bare body text", () => {
    const msg: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      senderName: "Charlie",
      text: "",
      timestamp: FIXED_TS,
      messageId: "1712800001.000200",
      threadId: "1712790000.000050",
      chatType: "channel",
      reaction: {
        action: "added",
        emoji: "eyes",
        targetMessageId: "1712800000.000100",
        targetSenderId: "U999",
      },
    };
    const content = formatChannelNotification(msg);
    // No body part — only reminder, since text is empty and no thread context.
    const [reminderPart] = expectTextParts(content, 1);

    expect(reminderPart!.text).toContain("**Reaction event**");
    expect(reminderPart!.text).toContain(
      "Charlie added `eyes` on message `1712800000.000100`",
    );
  });

  test("thread context is rendered as a structural <thread-context> XML block in the body part, before the user text", () => {
    const msg: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      senderName: "Charles",
      text: "please help",
      timestamp: FIXED_TS,
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      chatType: "channel",
      threadContext: {
        label: "Slack thread in #random",
        starter: {
          messageId: "1712790000.000050",
          senderId: "U111",
          senderName: "Alice",
          text: "Original question from the thread root",
        },
        history: [
          {
            messageId: "1712795000.000060",
            senderId: "U222",
            senderName: "Bob",
            text: "Some follow-up before the bot was tagged",
          },
        ],
      },
    };

    const body = buildChannelMessageBody(msg);

    expect(body).toContain('<thread-context label="Slack thread in #random">');
    expect(body).toContain(
      '<thread-starter sender_id="U111" sender_name="Alice" message_id="1712790000.000050">',
    );
    expect(body).toContain("Original question from the thread root");
    expect(body).toContain("<thread-history>");
    expect(body).toContain(
      '<thread-message sender_id="U222" sender_name="Bob" message_id="1712795000.000060">',
    );
    expect(body).toContain("Some follow-up before the bot was tagged");
    // User text is the last block in the body, separated from the XML by a
    // blank line so the model parses it as plain content.
    expect(body.endsWith("please help")).toBe(true);
    expect(body).toContain("</thread-context>\n\nplease help");
  });

  test("thread-context XML escapes special characters in entry text", () => {
    const msg: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "hi",
      timestamp: FIXED_TS,
      threadContext: {
        starter: {
          senderId: "U111",
          text: 'He said <hello> & "goodbye"',
        },
      },
    };
    const body = buildChannelMessageBody(msg);
    expect(body).toContain("&lt;hello&gt;");
    expect(body).toContain("&amp;");
    // double-quotes in element text are not escaped (only attributes are)
    expect(body).toContain('"goodbye"');
  });

  test("emits image content parts for inbound image attachments alongside the text parts", () => {
    const msg: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "See screenshot",
      timestamp: FIXED_TS,
      messageId: "1712800000.000100",
      chatType: "channel",
      attachments: [
        {
          id: "F123",
          name: "screenshot.png",
          mimeType: "image/png",
          kind: "image",
          localPath: "/tmp/screenshot.png",
          imageDataBase64: "YWJj",
        },
      ],
    };
    const content = formatChannelNotification(msg);
    expect(content).toHaveLength(3);
    expect((content as unknown[])[2]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "YWJj",
      },
    });
  });

  test("reaction-only event with no thread context produces a single reminder part (no body part)", () => {
    const msg: InboundChannelMessage = {
      channel: "matrix",
      chatId: "!room:server",
      senderId: "@alice:server",
      text: "",
      timestamp: FIXED_TS,
      reaction: {
        action: "added",
        emoji: "👍",
        targetMessageId: "$abc",
      },
    };
    const content = formatChannelNotification(msg);
    expectTextParts(content, 1);
  });

  test("group/channel messages show Type: Group/channel and Mentioned: yes when applicable", () => {
    const msg: InboundChannelMessage = {
      channel: "discord",
      chatId: "1234567890",
      senderId: "user-1",
      senderName: "Alice",
      text: "@bot help",
      timestamp: FIXED_TS,
      chatType: "channel",
      chatLabel: "general",
      isMention: true,
    };
    const reminder = buildChannelReminderText(msg);

    expect(reminder).toContain("- **Type**: Group/channel");
    expect(reminder).toContain("- **Label**: general");
    expect(reminder).toContain("- **Mentioned**: yes");
  });
});
