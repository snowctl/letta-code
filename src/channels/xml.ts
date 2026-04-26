/**
 * Envelope formatting for inbound channel messages.
 *
 * Produces a system-reminder block (sectioned markdown: metadata + chat
 * context + response directives) followed by the user's bare message text.
 * The structure is modeled on Lettabot's pattern: instructions and metadata
 * live inside the system-reminder; the user's actual words live outside it
 * as plain text — same shape as a normal user turn. This keeps the model
 * from having to parse two layers of XML to find what was said, and gives
 * it a clear `Stay silent` affordance to avoid replaying old messages on
 * autonomous re-triggers.
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../constants";
import type {
  ChannelMessageAttachment,
  ChannelThreadContext,
  ChannelThreadContextEntry,
  InboundChannelMessage,
} from "./types";

/**
 * Escape XML text-node content without over-escaping quotes that should remain
 * readable inside the rendered message body.
 */
function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape XML attribute values, including quotes.
 */
function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ── system-reminder builders ─────────────────────────────────────────────────

function formatReceivedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const d = new Date(timestamp);
  const iso = d.toISOString();
  const local = d.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `${iso} (${local})`;
}

function buildMetadataLines(msg: InboundChannelMessage): string[] {
  const lines: string[] = [];
  lines.push(`- **Channel**: ${msg.channel}`);
  lines.push(`- **Chat ID**: ${msg.chatId}`);
  if (msg.accountId) lines.push(`- **Account ID**: ${msg.accountId}`);
  const sender = msg.senderName
    ? `${msg.senderName} (${msg.senderId})`
    : msg.senderId;
  lines.push(`- **Sender**: ${sender}`);
  if (msg.messageId) lines.push(`- **Message ID**: ${msg.messageId}`);
  if (msg.threadId) lines.push(`- **Thread ID**: ${msg.threadId}`);
  const received = formatReceivedAt(msg.timestamp);
  if (received) lines.push(`- **Received at**: ${received}`);
  return lines;
}

function buildChatContextLines(msg: InboundChannelMessage): string[] {
  const lines: string[] = [];
  const chatType = msg.chatType ?? "direct";
  if (chatType === "channel") {
    lines.push(`- **Type**: Group/channel`);
    if (msg.chatLabel) lines.push(`- **Label**: ${msg.chatLabel}`);
    if (msg.isMention) lines.push(`- **Mentioned**: yes`);
  } else {
    lines.push(`- **Type**: Direct message`);
  }

  if (msg.reaction) {
    const senderName = msg.senderName ?? msg.senderId;
    lines.push(
      `- **Reaction event**: ${senderName} ${msg.reaction.action} \`${msg.reaction.emoji}\` on message \`${msg.reaction.targetMessageId}\``,
    );
  }

  if (msg.attachments?.length) {
    for (const att of msg.attachments) {
      const parts: string[] = [`kind=${att.kind}`, `local_path=${att.localPath}`];
      if (att.mimeType) parts.push(`mime_type=${att.mimeType}`);
      if (typeof att.sizeBytes === "number") parts.push(`size=${att.sizeBytes}`);
      if (att.name) parts.push(`name=${att.name}`);
      lines.push(`- **Attachment**: ${parts.join(", ")}`);
      if (att.transcription) {
        lines.push(`  - Transcription: ${JSON.stringify(att.transcription)}`);
      }
    }
  }

  // Slack: replies in a threaded channel stay in-thread automatically.
  const threadKey = msg.threadId ?? msg.messageId;
  if (
    msg.channel === "slack" &&
    chatType === "channel" &&
    threadKey?.trim()
  ) {
    lines.push(
      "- **Slack threading**: replies via MessageChannel will stay in this thread automatically",
    );
  }

  return lines;
}

function emojiHintForChannel(channel: string): string {
  if (channel === "slack") {
    return "a reaction name like `thumbsup` or `eyes`";
  }
  if (channel === "discord") {
    return "a unicode emoji or custom emoji syntax like `<:name:id>`";
  }
  return "a unicode emoji";
}

function buildResponseDirectives(msg: InboundChannelMessage): string[] {
  const channel = msg.channel;
  const lines: string[] = [];

  // Lead with the strongest possible imperative. Plain assistant text
  // does not reach the user on any channel — the platform delivery path
  // is exclusively the MessageChannel tool. Without this header the
  // model frequently produces a normal text reply, which silently
  // disappears and looks to the user like the bot ignored them.
  lines.push(
    "**You MUST respond via the `MessageChannel` tool.** Plain assistant text is not delivered to the user on any channel — only `MessageChannel` calls reach the chat platform. The only way to stay silent is to end the turn without calling any tool. Do not write a final assistant message intending it to reach the user; it will be discarded.",
  );
  lines.push("");

  lines.push(
    `- **Reply with text** — call \`MessageChannel\` with \`action="send"\`, \`channel="${channel}"\`, and \`chat_id\` from the metadata above. Put your reply text in \`message\`.`,
  );

  // All four supported channels (matrix, telegram, slack, discord) accept
  // reactions via MessageChannel — see channels/*/messageActions.ts.
  lines.push(
    `- **React without text** — for acknowledgments, affirmations, or "I saw it" signals, prefer this over a short text reply. Call \`MessageChannel\` with \`action="react"\`, \`channel="${channel}"\`, \`chat_id\` and \`messageId\` from the metadata above, and \`emoji\` set to ${emojiHintForChannel(channel)} (e.g. \`👍\`, \`❤️\`, \`👀\`, \`🔥\`, \`🎉\`).`,
  );

  lines.push(
    `- **Remove a reaction** — call \`MessageChannel\` with \`action="react"\`, \`remove=true\`, and the same \`chat_id\` / \`messageId\` / \`emoji\` you previously sent.`,
  );

  if (msg.attachments?.length) {
    lines.push(
      "- **Inspect attachments** — local file/image tools (e.g. `Read`, `ViewImage`) can open the `local_path` of any attachment listed in the chat context above.",
    );
  }

  lines.push(
    "- **Stay silent (rare)** — only when no reply is warranted at all (an old message you already addressed, an autonomous self-prompt, or a duplicate notification). End the turn without calling any tool. Default expectation is to respond; silence is the exception, not the fallback.",
  );

  lines.push(
    "- `replyTo` — set only if you intentionally want the platform's quote/reply UI on a text reply.",
  );

  return lines;
}

/**
 * Build the system-reminder block: sectioned markdown with metadata, chat
 * context, and response directives. The user's actual message text is *not*
 * included here — it lives outside the reminder, emitted by
 * `buildChannelMessageBody`.
 */
export function buildChannelReminderText(msg: InboundChannelMessage): string {
  const sections: string[] = [];
  sections.push(`## Message Metadata\n${buildMetadataLines(msg).join("\n")}`);
  const ctx = buildChatContextLines(msg);
  if (ctx.length > 0) sections.push(`## Chat Context\n${ctx.join("\n")}`);
  sections.push(
    `## Response Directives\n${buildResponseDirectives(msg).join("\n")}`,
  );
  return [SYSTEM_REMINDER_OPEN, sections.join("\n\n"), SYSTEM_REMINDER_CLOSE].join(
    "\n",
  );
}

// ── message-body builders ────────────────────────────────────────────────────

function buildThreadContextEntryXml(
  tagName: string,
  entry: ChannelThreadContextEntry,
): string {
  const attrs: string[] = [];
  if (entry.senderId) attrs.push(`sender_id="${escapeXmlAttribute(entry.senderId)}"`);
  if (entry.senderName) {
    attrs.push(`sender_name="${escapeXmlAttribute(entry.senderName)}"`);
  }
  if (entry.messageId) {
    attrs.push(`message_id="${escapeXmlAttribute(entry.messageId)}"`);
  }
  const attrString = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  return `<${tagName}${attrString}>\n${escapeXmlText(entry.text)}\n</${tagName}>`;
}

function buildThreadContextXml(threadContext: ChannelThreadContext): string | null {
  const parts: string[] = [];
  if (threadContext.starter) {
    parts.push(buildThreadContextEntryXml("thread-starter", threadContext.starter));
  }
  const historyEntries = threadContext.history ?? [];
  if (historyEntries.length > 0) {
    parts.push(
      [
        "<thread-history>",
        ...historyEntries.map((entry) =>
          buildThreadContextEntryXml("thread-message", entry),
        ),
        "</thread-history>",
      ].join("\n"),
    );
  }
  if (parts.length === 0) return null;
  const attrs = threadContext.label
    ? ` label="${escapeXmlAttribute(threadContext.label)}"`
    : "";
  return [`<thread-context${attrs}>`, ...parts, "</thread-context>"].join("\n");
}

/**
 * Build the message-body part: thread context (if any) followed by the
 * user's bare message text. Returns an empty string when the message has no
 * text and no thread context (e.g. a reaction-only event — its details are
 * already in the system-reminder's Chat Context section).
 */
export function buildChannelMessageBody(msg: InboundChannelMessage): string {
  const parts: string[] = [];
  if (msg.threadContext) {
    const threadXml = buildThreadContextXml(msg.threadContext);
    if (threadXml) parts.push(threadXml);
  }
  const text = msg.text?.trim();
  if (text) parts.push(text);
  return parts.join("\n\n");
}

// ── top-level formatter ──────────────────────────────────────────────────────

function imageContentParts(attachments: ChannelMessageAttachment[] | undefined) {
  if (!attachments?.length) return [];
  return attachments.flatMap((attachment) => {
    if (
      attachment.kind !== "image" ||
      typeof attachment.imageDataBase64 !== "string" ||
      attachment.imageDataBase64.length === 0 ||
      typeof attachment.mimeType !== "string" ||
      !attachment.mimeType.startsWith("image/")
    ) {
      return [];
    }
    return [
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: attachment.mimeType,
          data: attachment.imageDataBase64,
        },
      },
    ];
  });
}

/**
 * Format an inbound channel message as structured content parts.
 *
 * Output layout:
 *   1. Reminder text — system-reminder with sectioned-markdown metadata,
 *      chat context, and response directives.
 *   2. Message body  — thread-context XML (if any) + the user's bare text.
 *      Skipped entirely when the body would be empty (e.g. reaction-only
 *      events have no body — the reaction is described in chat context).
 *   3. Image content parts — one per inline-decodable image attachment.
 */
export function formatChannelNotification(
  msg: InboundChannelMessage,
): MessageCreate["content"] {
  const reminderText = buildChannelReminderText(msg);
  const bodyText = buildChannelMessageBody(msg);
  const textParts: Array<{ type: "text"; text: string }> = [
    { type: "text", text: reminderText },
  ];
  if (bodyText) textParts.push({ type: "text", text: bodyText });
  return [
    ...textParts,
    ...imageContentParts(msg.attachments),
  ] as MessageCreate["content"];
}
