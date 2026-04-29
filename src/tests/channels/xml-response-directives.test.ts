import { expect, test } from "bun:test";
import type { InboundChannelMessage } from "../../channels/types";
import { buildChannelReminderText } from "../../channels/xml";

function makeTestInboundMessage(): InboundChannelMessage {
  return {
    channel: "telegram",
    chatId: "123",
    chatType: "direct",
    text: "Hello",
    messageId: "1",
    accountId: undefined,
    threadId: null,
    attachments: [],
    senderId: "user42",
    timestamp: 0,
  };
}

test("Response Directives no longer mention MessageChannel", () => {
  const msg = makeTestInboundMessage();
  const text = buildChannelReminderText(msg);
  expect(text).not.toContain("MessageChannel");
  expect(text).not.toContain("You MUST respond via");
});

test("Response Directives explain auto-forward model", () => {
  const msg = makeTestInboundMessage();
  const text = buildChannelReminderText(msg);
  expect(text).toContain("delivered automatically");
  expect(text).toContain("ChannelAction");
});
