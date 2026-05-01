// src/channels/matrix/controlRequests.ts
import { formatChannelControlRequestPrompt } from "../interactive";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelControlRequestKind,
} from "../types";
import type { MatrixBotSdkClient } from "./client";
import { markdownToMatrixHtml } from "./htmlFormat";
import type { MatrixSender } from "./matrixSender";

// ── Control request state ─────────────────────────────────────────────────────

export const KEYCAP_EMOJIS = [
  "1️⃣",
  "2️⃣",
  "3️⃣",
  "4️⃣",
  "5️⃣",
  "6️⃣",
  "7️⃣",
  "8️⃣",
  "9️⃣",
  "🔟",
];

export type AskUserQuestionInput = {
  questions?: Array<{
    question?: string;
    options?: Array<{ label?: string; description?: string }>;
    multiSelect?: boolean;
  }>;
};

export type PendingReactionRequest = {
  requestId: string;
  kind: ChannelControlRequestKind;
  chatId: string;
  senderId: string | null;
  sentEmojis: string[];
  sentReactionEventIds: Map<string, string>;
  awaitingFreeform: boolean;
};

// ── Stateless helpers ─────────────────────────────────────────────────────────

export function buildFreeformKey(chatId: string, senderId: string): string {
  return `${chatId}:${senderId}`;
}

export function emojiToSyntheticText(emoji: string): string | null {
  if (emoji === "✅") return "approve";
  if (emoji === "❌") return "deny";
  const keycapIndex = KEYCAP_EMOJIS.indexOf(emoji);
  if (keycapIndex !== -1) return String(keycapIndex + 1);
  return null;
}

export function buildMatrixControlRequestPrompt(
  event: ChannelControlRequestEvent,
): {
  promptText: string;
  emojis: string[];
} {
  switch (event.kind) {
    case "generic_tool_approval": {
      const inputStr = JSON.stringify(event.input, null, 2);
      const truncated =
        inputStr.length > 1200 ? `${inputStr.slice(0, 1197)}...` : inputStr;
      const lines = [`The agent wants approval to run \`${event.toolName}\`.`];
      if (truncated && truncated !== "{}")
        lines.push("", "Tool input:", truncated);
      lines.push("", "approve   deny   deny with reason");
      return { promptText: lines.join("\n"), emojis: ["✅", "❌", "📝"] };
    }

    case "enter_plan_mode":
      return {
        promptText:
          "The agent wants to enter plan mode before making changes.\n\napprove   deny",
        emojis: ["✅", "❌"],
      };

    case "exit_plan_mode": {
      const lines = [
        "The agent is ready to leave plan mode and start implementing.",
      ];
      if (event.planContent?.trim()) {
        const preview =
          event.planContent.length > 1800
            ? `${event.planContent.slice(0, 1797)}...`
            : event.planContent;
        lines.push("", "Proposed plan:", preview);
        if (event.planFilePath?.trim())
          lines.push("", `Plan file: ${event.planFilePath.trim()}`);
      }
      lines.push("", "approve   provide feedback");
      return { promptText: lines.join("\n"), emojis: ["✅", "📝"] };
    }

    case "ask_user_question": {
      const input = event.input as AskUserQuestionInput;
      const questions = (input.questions ?? []).filter((q) =>
        q.question?.trim(),
      );
      const firstQ = questions[0];

      if (!firstQ || questions.length > 1) {
        return {
          promptText: formatChannelControlRequestPrompt(event),
          emojis: [],
        };
      }

      const options = firstQ.options ?? [];
      const lines = [
        "The agent needs an answer before it can continue.",
        "",
        firstQ.question ?? "Please choose an option:",
      ];
      const emojis: string[] = [];

      options.slice(0, 10).forEach((opt, i) => {
        const emoji = KEYCAP_EMOJIS[i]!;
        emojis.push(emoji);
        const label = opt.label?.trim() || `Option ${i + 1}`;
        const desc = opt.description?.trim();
        lines.push(
          desc ? `  ${emoji}  ${label} — ${desc}` : `  ${emoji}  ${label}`,
        );
      });

      if (options.length > 10) {
        lines.push("", "Additional options (type the number or label):");
        options.slice(10).forEach((opt, i) => {
          lines.push(`  ${i + 11}) ${opt.label?.trim() || `Option ${i + 11}`}`);
        });
      }

      if (options.length > 0) {
        emojis.push("📝");
        lines.push("  📝  type a custom answer");
      }

      return { promptText: lines.join("\n"), emojis };
    }

    default: {
      const _exhaustive: never = event.kind;
      return {
        promptText: formatChannelControlRequestPrompt(event),
        emojis: [],
      };
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export interface ControlRequestsDeps {
  sender: MatrixSender;
  client: MatrixBotSdkClient;
  pendingReactionRequests: Map<string, PendingReactionRequest>;
  awaitingFreeformByChat: Map<string, string>;
  getOnMessage: () => ChannelAdapter["onMessage"];
  userId: string;
  accountId: string;
}

export interface ControlRequests {
  handleControlRequestEvent(event: ChannelControlRequestEvent): Promise<void>;
  handleReactionEvent(
    roomId: string,
    event: Record<string, unknown>,
  ): Promise<void>;
  handleRedactionEvent(
    roomId: string,
    event: Record<string, unknown>,
  ): Promise<void>;
  redactControlRequestReactions(req: PendingReactionRequest): Promise<void>;
}

export function createControlRequests(
  deps: ControlRequestsDeps,
): ControlRequests {
  const {
    sender,
    client,
    pendingReactionRequests,
    awaitingFreeformByChat,
    getOnMessage,
    userId,
    accountId,
  } = deps;

  async function redactControlRequestReactions(
    req: PendingReactionRequest,
  ): Promise<void> {
    for (const [, reactionEventId] of req.sentReactionEventIds) {
      try {
        await sender.redact(req.chatId, reactionEventId);
      } catch {
        // best-effort cleanup
      }
    }
  }

  async function handleControlRequestEvent(
    event: ChannelControlRequestEvent,
  ): Promise<void> {
    const { chatId, messageId, threadId } = event.source;

    const { promptText, emojis } = buildMatrixControlRequestPrompt(event);

    const { html, plaintext } = markdownToMatrixHtml(promptText);
    const replyToId = threadId ?? messageId;
    const promptEventId = await sender.sendNew(chatId, {
      text: plaintext,
      html,
      replyToMessageId: replyToId ?? undefined,
    });

    // Pre-react with all applicable emojis
    const sentReactionEventIds = new Map<string, string>();
    for (const emoji of emojis) {
      try {
        const reactionEventId = await sender.sendReaction(
          chatId,
          promptEventId,
          emoji,
        );
        sentReactionEventIds.set(emoji, String(reactionEventId));
      } catch (err) {
        console.warn(`[matrix] Failed to pre-react with ${emoji}:`, err);
      }
    }

    // senderId is null when the control request originates from a tool call
    // (no associated Matrix user). Reaction handling skips the sender check in that case.
    pendingReactionRequests.set(String(promptEventId), {
      requestId: event.requestId,
      kind: event.kind,
      chatId,
      senderId: null,
      sentEmojis: emojis,
      sentReactionEventIds,
      awaitingFreeform: false,
    });
  }

  async function handleReactionEvent(
    roomId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    const content = event.content as Record<string, unknown> | undefined;
    const relatesTo = content?.["m.relates_to"] as
      | Record<string, unknown>
      | undefined;
    if (!relatesTo) return;

    const targetEventId = relatesTo.event_id as string | undefined;
    const emoji = relatesTo.key as string | undefined;
    const senderIdStr = event.sender as string;

    if (!targetEventId || !emoji) return;
    if (senderIdStr === userId) return;

    // Check if this targets a pending control request
    const pending = pendingReactionRequests.get(targetEventId);
    if (pending) {
      // If senderId is known, validate the reactor matches
      if (pending.senderId !== null && senderIdStr !== pending.senderId) return;

      if (emoji === "📝") {
        pending.awaitingFreeform = true;
        const freeformKey = buildFreeformKey(roomId, senderIdStr);
        awaitingFreeformByChat.set(freeformKey, pending.requestId);
        const followUpText =
          pending.kind === "ask_user_question"
            ? "Please type your answer:"
            : "Please type your reason for denying:";
        await sender.sendNew(roomId, { text: followUpText });
        return;
      }

      const syntheticText = emojiToSyntheticText(emoji);
      if (!syntheticText) return;

      pendingReactionRequests.delete(targetEventId);
      await redactControlRequestReactions(pending);

      const members = await client.getJoinedRoomMembers(roomId).catch(() => []);
      const chatType = members.length === 2 ? "direct" : "channel";

      await getOnMessage()?.({
        channel: "matrix",
        accountId,
        chatId: roomId,
        senderId: senderIdStr,
        text: syntheticText,
        timestamp: Date.now(),
        chatType,
      });
      return;
    }

    // Normal reaction — emit as InboundChannelMessage
    await getOnMessage()?.({
      channel: "matrix",
      accountId,
      chatId: roomId,
      senderId: senderIdStr,
      text: "",
      timestamp: Date.now(),
      reaction: {
        action: "added",
        emoji,
        targetMessageId: targetEventId,
      },
    });
  }

  async function handleRedactionEvent(
    _roomId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    const redactedEventId = event.redacts as string | undefined;
    if (!redactedEventId) return;

    // Check if this redaction targets one of our own pre-reactions — if so, ignore
    for (const [, pending] of pendingReactionRequests) {
      for (const [, reactionEventId] of pending.sentReactionEventIds) {
        if (reactionEventId === redactedEventId) {
          return;
        }
      }
    }
    // Otherwise: user removed a non-control-request reaction.
    // matrix-bot-sdk doesn't provide the emoji in the redaction event, so we skip emitting.
  }

  return {
    handleControlRequestEvent,
    handleReactionEvent,
    handleRedactionEvent,
    redactControlRequestReactions,
  };
}
