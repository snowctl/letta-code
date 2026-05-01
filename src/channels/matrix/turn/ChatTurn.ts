// src/channels/matrix/turn/ChatTurn.ts
//
// Per-chat turn coordinator. Owns the ThinkingBlock, ToolBlock, and
// StreamingMessage for a single Matrix chat. Each stream segment closes by
// replacing its preview with canonical HTML on tool interruption, not just on
// turn-end. Task 9 swaps in the streaming-safe markdown formatter.

import type {
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  MatrixChannelAccount,
  OutboundChannelMessage,
} from "../../types";
import type { MatrixBotSdkClient } from "../client";
import {
  escapeHtml,
  formatCompact,
  formatElapsed,
  markdownToMatrixHtml,
} from "../htmlFormat";
import type { MatrixSender } from "../matrixSender";
import { type StreamingFormatter, StreamingMessage } from "./StreamingMessage";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolBlock, type ToolStartCall } from "./ToolBlock";

const TYPING_TICK_MS = 4_000;

export interface ChatTurnDeps {
  chatId: string;
  sender: MatrixSender;
  client: MatrixBotSdkClient;
  account: MatrixChannelAccount;
  /** Called when the turn completes — registry deletes the entry. */
  onDispose: (chatId: string) => void;
  /** Conversation IDs for tracking last-sent message per conversation. */
  setLastSentMessageId: (conversationId: string, messageId: string) => void;
}

export class ChatTurn {
  // Blocks
  thinking: ThinkingBlock | null = null;
  private toolBlock: ToolBlock | null = null;
  private currentStream: StreamingMessage | null = null;

  // Lifecycle state
  private lastResponse: { eventId: string; text: string; html: string } | null =
    null;
  private pendingResponseText: string | null = null;
  private startedAt = Date.now();
  private typingTimer: ReturnType<typeof setInterval> | null = null;

  // Stream formatter — Task 9 swaps in streamingMarkdownToHtml
  private streamFormatter: StreamingFormatter = (text) => {
    const { html, plaintext } = markdownToMatrixHtml(text);
    return { text: plaintext, html };
  };

  constructor(private deps: ChatTurnDeps) {}

  dispose(): void {
    this.stopTyping();
    this.currentStream?.dispose();
    this.currentStream = null;
  }

  // ── Lifecycle delegates ────────────────────────────────────────────────────

  onQueued(): void {
    this.startTyping();
  }

  onProcessing(): void {
    this.startTyping();
    this.startedAt = Date.now();
  }

  async onReasoningChunk(text: string): Promise<void> {
    if (this.deps.account.showReasoning === false) return;
    if (!this.thinking) {
      this.thinking = new ThinkingBlock(this.deps.chatId, this.deps.sender);
    }
    this.thinking.appendChunk(text);
  }

  /** Tool call scheduled into the tool-block list. */
  onToolCallScheduled(toolName: string, description?: string): void {
    // Mark tool interruption in thinking block so next reasoning chunk gets separator.
    if (this.thinking) this.thinking.markToolInterruption();

    // Ensure a ToolBlock exists for this turn.
    if (!this.toolBlock) {
      this.toolBlock = new ToolBlock(this.deps.chatId, this.deps.sender);
    }

    // Add the scheduled entry to the block.
    this.toolBlock.onToolScheduled(toolName, description);
  }

  /** Live-progress: tool started — wire to ToolBlock for per-tool timing (fixes #6). */
  onToolStart(call: ToolStartCall): void {
    if (!this.toolBlock) {
      this.toolBlock = new ToolBlock(this.deps.chatId, this.deps.sender);
    }
    this.toolBlock.onToolStart(call);
  }

  onToolEnd(
    toolCallId: string,
    _durationMs: number,
    outcome: "success" | "error",
  ): void {
    this.toolBlock?.onToolEnd(toolCallId, outcome);
  }

  /** handleStreamText — backed by StreamingMessage. */
  async onStreamText(accumulatedText: string): Promise<void> {
    if (!this.currentStream) {
      this.currentStream = new StreamingMessage(
        this.deps.chatId,
        this.deps.sender,
        this.streamFormatter,
      );
      this.stopTyping();
    }
    this.currentStream.onChunk(accumulatedText);
  }

  /** Close the current stream segment, replacing its preview with fully-formatted
   *  HTML. The segment becomes a properly-formatted message in the timeline.
   *  Next onStreamText call starts a fresh segment. */
  async onStreamReset(): Promise<void> {
    if (!this.currentStream) return;
    const latestText = this.currentStream.latestTextSnapshot;
    const { html, plaintext } = markdownToMatrixHtml(latestText);
    const id = await this.currentStream.replaceWithFinal({
      text: plaintext,
      html,
    });
    this.lastResponse = { eventId: id, text: latestText, html };
    this.currentStream = null;
  }

  setPendingResponseText(text: string): void {
    // If sendMessage (ChannelAction/NotifyUser) already delivered a message
    // this turn, lastResponse is set — skip so the "finished" handler uses
    // the lastResponse fallback to append the footer.
    if (!this.lastResponse) {
      this.pendingResponseText = text;
    }
  }

  // ── Terminal paths ─────────────────────────────────────────────────────────

  async finish(
    event: Extract<ChannelTurnLifecycleEvent, { type: "finished" }>,
  ): Promise<void> {
    this.stopTyping();

    // Finalize tool block BEFORE final response — fixes issue #1.
    if (this.toolBlock) {
      await this.toolBlock.finalize().catch(() => {});
    }

    const durationStr = formatElapsed(Date.now() - this.startedAt);
    const usage = event.usage;
    const showUsage =
      this.deps.account.showContextUsage !== false &&
      usage &&
      usage.contextTokens > 0 &&
      usage.contextWindowMax > 0;
    const usageSuffix = showUsage
      ? ` · ${formatCompact(usage.contextTokens)} / ${formatCompact(usage.contextWindowMax)} tokens`
      : "";
    const usageHtml = showUsage
      ? ` <span data-mx-color="#8b949e">· ${formatCompact(usage.contextTokens)} / ${formatCompact(usage.contextWindowMax)} tokens</span>`
      : "";
    const completedFooterHtml =
      `<hr><span data-mx-color="#3fb950">✓</span> ` +
      `<span data-mx-color="#8b949e">completed in ${durationStr}</span>${usageHtml}`;
    const completedFooterText = `\n✓ completed in ${durationStr}${usageSuffix}`;

    if (event.outcome === "completed") {
      await this.commitFinalResponse(
        { html: completedFooterHtml, text: completedFooterText },
        event.sources,
      );
      await this.thinking?.finalize();
    } else if (event.outcome === "error") {
      const errorDetail = event.error ? `: ${event.error}` : "";
      const errFooterHtml =
        `<span data-mx-color="#f85149">⚠ Turn failed</span>` +
        `<span data-mx-color="#8b949e"> · tool error${escapeHtml(errorDetail)}</span>`;
      const errFooterText = `⚠ Turn failed · tool error${errorDetail}`;
      if (this.thinking) {
        await this.thinking.finalize({
          html: errFooterHtml,
          text: errFooterText,
        });
      } else {
        const fallbackDetail = event.error
          ? `: ${event.error}`
          : " — the turn didn't complete.";
        await this.deps.sender
          .sendNew(this.deps.chatId, {
            text: `⚠ Turn failed${fallbackDetail}`,
            html:
              `<span data-mx-color="#f85149">⚠ Turn failed</span>` +
              `<span data-mx-color="#8b949e">${escapeHtml(fallbackDetail)}</span>`,
          })
          .catch(() => {});
      }
    } else {
      // cancelled
      if (this.thinking) {
        await this.thinking.finalize({
          html: `<span data-mx-color="#e3b341">· Cancelled</span>`,
          text: "· Cancelled",
        });
      }
    }

    // Dispose any dangling stream.
    this.currentStream?.dispose();
    this.currentStream = null;

    this.deps.onDispose(this.deps.chatId);
  }

  /** sendOutbound — replaces adapter.sendMessage plain-text branch. */
  async sendOutbound(
    msg: OutboundChannelMessage,
  ): Promise<{ messageId: string }> {
    // Wait for tool block to be posted so it lands above the response.
    if (this.toolBlock) {
      await this.toolBlock.posted.catch(() => {});
      await this.toolBlock.drainPending();
    }
    this.stopTyping();

    const { html, plaintext } = markdownToMatrixHtml(msg.text);

    if (this.currentStream) {
      const id = await this.currentStream.replaceWithFinal({
        text: plaintext,
        html,
      });
      this.currentStream = null;
      this.lastResponse = { eventId: id, text: msg.text, html };
      return { messageId: id };
    }

    const id = await this.deps.sender.sendNew(this.deps.chatId, {
      text: plaintext,
      html,
      replyToMessageId: msg.replyToMessageId,
    });
    this.lastResponse = { eventId: id, text: msg.text, html };
    return { messageId: id };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Selects the send path for the final response. */
  private async commitFinalResponse(
    footer: { text: string; html: string },
    sources: ReadonlyArray<ChannelTurnSource>,
  ): Promise<void> {
    if (this.pendingResponseText) {
      const { html, plaintext } = markdownToMatrixHtml(
        this.pendingResponseText,
      );
      const finalContent = {
        text: plaintext + footer.text,
        html: html + footer.html,
      };

      let messageId: string;
      if (this.currentStream) {
        messageId = await this.currentStream.replaceWithFinal(finalContent);
        this.currentStream = null;
      } else {
        messageId = await this.deps.sender
          .sendNew(this.deps.chatId, finalContent)
          .catch(() => "");
      }

      if (messageId) {
        const src = sources.find((s) => s.chatId === this.deps.chatId);
        if (src) this.deps.setLastSentMessageId(src.conversationId, messageId);
        this.lastResponse = {
          eventId: messageId,
          text: this.pendingResponseText,
          html,
        };
      }
      this.pendingResponseText = null;
    } else if (this.lastResponse) {
      // Footer-only edit on lastResponse (ChannelAction-only turn).
      await this.deps.sender
        .edit(this.deps.chatId, this.lastResponse.eventId, {
          text: this.lastResponse.text + footer.text,
          html: this.lastResponse.html + footer.html,
        })
        .catch(() => {});
    }
  }

  private startTyping(): void {
    if (this.typingTimer) return;
    void this.deps.client
      .setTyping(this.deps.chatId, true, 8000)
      .catch(() => {});
    this.typingTimer = setInterval(() => {
      void this.deps.client
        .setTyping(this.deps.chatId, true, 8000)
        .catch(() => {});
    }, TYPING_TICK_MS);
  }

  private stopTyping(): void {
    if (!this.typingTimer) return;
    clearInterval(this.typingTimer);
    this.typingTimer = null;
    void this.deps.client.setTyping(this.deps.chatId, false).catch(() => {});
  }
}
