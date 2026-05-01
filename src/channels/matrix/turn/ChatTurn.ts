// src/channels/matrix/turn/ChatTurn.ts
//
// Per-chat turn coordinator. Owns the ThinkingBlock and shimmed tool-block /
// stream-message state for a single Matrix chat. Tasks 6 and 7 replace the
// shim sections with proper ToolBlock and StreamingMessage instances.

import {
  renderToolBlock,
  type ToolCallGroup,
  upsertToolCallGroup,
} from "../../tool-block";
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
import { ThinkingBlock } from "./ThinkingBlock";

const TYPING_TICK_MS = 4_000;
const MATRIX_STREAM_INTERVAL_MS = 500;
const MATRIX_STREAM_INTERVAL_MAX_MS = 8_000;

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

// ── Stream shim state (replaced in Task 7) ───────────────────────────────────

interface StreamShimState {
  messageId: string;
  /** Resolves to the real messageId (or null on failure) once the initial
   *  sendMessage call settles. Set only while messageId === "__pending__". */
  pendingMessageId: Promise<string | null> | null;
  lastText: string;
  lastEditAt: number;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  currentInterval: number;
}

export class ChatTurn {
  // Blocks
  thinking: ThinkingBlock | null = null;

  // Stream shim (replaced in Task 7 by StreamingMessage)
  private streamState: StreamShimState | null = null;

  // Tool-block shim (replaced in Task 6 by ToolBlock)
  private toolBlockMessageId: string | null = null;
  private toolBlockGroups: ToolCallGroup[] = [];
  private toolBlockOp: Promise<void> = Promise.resolve();

  // Lifecycle state
  private lastResponse: { eventId: string; text: string; html: string } | null =
    null;
  private pendingResponseText: string | null = null;
  private startedAt = Date.now();
  private typingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: ChatTurnDeps) {}

  dispose(): void {
    this.stopTyping();
    if (this.streamState?.pendingTimer) {
      clearTimeout(this.streamState.pendingTimer);
    }
    this.streamState = null;
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

  /** Tool call scheduled into the tool-block list.
   *  Shim — replaced in Task 6 by ToolBlock. */
  onToolCallScheduled(toolName: string, description?: string): void {
    // Mark tool interruption in thinking block so next reasoning chunk gets separator.
    if (this.thinking) this.thinking.markToolInterruption();

    // Chain tool-block update to serialize edits.
    this.toolBlockOp = this.toolBlockOp
      .catch(() => {})
      .then(async () => {
        const newGroups = upsertToolCallGroup(
          this.toolBlockGroups,
          toolName,
          description,
        );
        const text = renderToolBlock(newGroups);
        if (this.toolBlockMessageId === null) {
          const id = await this.deps.sender.sendNew(this.deps.chatId, { text });
          this.toolBlockMessageId = id;
        } else {
          await this.deps.sender.edit(
            this.deps.chatId,
            this.toolBlockMessageId,
            { text },
          );
        }
        this.toolBlockGroups = newGroups;
      })
      .catch(() => {});
  }

  /** Live-progress signals — no-op shim.
   *  Task 6 wires per-tool timers to the tool block.
   *  The thinking-placeholder running-tool inset that today's adapter renders
   *  is REMOVED here, fixing the empty-thinking-block bug. */
  onToolStart(_call: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    timeoutMs?: number;
  }): void {
    /* no-op shim until Task 6 */
  }

  onToolEnd(
    _toolCallId: string,
    _durationMs: number,
    _outcome: "success" | "error",
  ): void {
    /* no-op shim until Task 6 */
  }

  /** handleStreamText — shim. Task 7 replaces with StreamingMessage. */
  async onStreamText(accumulatedText: string): Promise<void> {
    if (!this.streamState) {
      // Claim slot synchronously to prevent races from concurrent calls.
      let resolvePendingMessageId: (id: string | null) => void = () => {};
      const sentinel: StreamShimState = {
        messageId: "__pending__",
        pendingMessageId: new Promise<string | null>((resolve) => {
          resolvePendingMessageId = resolve;
        }),
        lastText: accumulatedText,
        lastEditAt: Date.now(),
        pendingTimer: null,
        currentInterval: MATRIX_STREAM_INTERVAL_MS,
      };
      this.streamState = sentinel;
      this.stopTyping();
      try {
        const eventId = await this.deps.sender.sendNew(this.deps.chatId, {
          text: accumulatedText,
        });
        sentinel.messageId = String(eventId);
        sentinel.pendingMessageId = null;
        resolvePendingMessageId(String(eventId));
        // If more text arrived while the initial send was in flight,
        // send an immediate edit so the latest content is visible right away.
        if (sentinel.lastText !== accumulatedText) {
          sentinel.lastEditAt = Date.now();
          void this.editStreamMessage(sentinel.lastText);
        }
      } catch (error) {
        this.streamState = null;
        resolvePendingMessageId(null);
        console.error(
          "[Matrix] Initial stream post failed:",
          error instanceof Error ? error.message : error,
        );
      }
      return;
    }

    // Still waiting for the initial sendMessage to resolve — keep latest text.
    if (this.streamState.messageId === "__pending__") {
      this.streamState.lastText = accumulatedText;
      return;
    }

    this.streamState.lastText = accumulatedText;
    const elapsed = Date.now() - this.streamState.lastEditAt;

    if (elapsed >= this.streamState.currentInterval) {
      if (this.streamState.pendingTimer) {
        clearTimeout(this.streamState.pendingTimer);
        this.streamState.pendingTimer = null;
      }
      void this.editStreamMessage(accumulatedText);
    } else {
      if (this.streamState.pendingTimer)
        clearTimeout(this.streamState.pendingTimer);
      const state = this.streamState;
      state.pendingTimer = setTimeout(() => {
        state.pendingTimer = null;
        void this.editStreamMessage(state.lastText);
      }, state.currentInterval - elapsed);
    }
  }

  async onStreamReset(): Promise<void> {
    if (this.streamState?.pendingTimer) {
      clearTimeout(this.streamState.pendingTimer);
    }
    this.streamState = null;
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

    // Drain tool-block edits BEFORE final response — fixes issue #1.
    await this.toolBlockOp.catch(() => {});

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

    // Clean up dangling stream state.
    if (this.streamState?.pendingTimer)
      clearTimeout(this.streamState.pendingTimer);
    this.streamState = null;

    this.deps.onDispose(this.deps.chatId);
  }

  /** sendOutbound — replaces adapter.sendMessage plain-text branch. */
  async sendOutbound(
    msg: OutboundChannelMessage,
  ): Promise<{ messageId: string }> {
    // Drain tool-block first so it lands above the response.
    await this.toolBlockOp.catch(() => {});
    this.stopTyping();

    const { html, plaintext } = markdownToMatrixHtml(msg.text);

    if (this.streamState && this.streamState.messageId !== "__pending__") {
      // Replace the open stream preview with the canonical response.
      if (this.streamState.pendingTimer)
        clearTimeout(this.streamState.pendingTimer);
      const streamMessageId = this.streamState.messageId;
      this.streamState = null;
      await this.deps.sender.edit(this.deps.chatId, streamMessageId, {
        text: plaintext,
        html,
      });
      this.lastResponse = { eventId: streamMessageId, text: msg.text, html };
      return { messageId: streamMessageId };
    }

    // If still pending, wait for it before sending new message.
    if (this.streamState?.pendingMessageId) {
      await this.streamState.pendingMessageId;
      // After awaiting, check if we can now do the stream replace.
      if (this.streamState && this.streamState.messageId !== "__pending__") {
        if (this.streamState.pendingTimer)
          clearTimeout(this.streamState.pendingTimer);
        const streamMessageId = this.streamState.messageId;
        this.streamState = null;
        await this.deps.sender.edit(this.deps.chatId, streamMessageId, {
          text: plaintext,
          html,
        });
        this.lastResponse = { eventId: streamMessageId, text: msg.text, html };
        return { messageId: streamMessageId };
      }
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

  /** Selects the send path for the final response. Refactored in Task 7. */
  private async commitFinalResponse(
    footer: { text: string; html: string },
    sources: ReadonlyArray<ChannelTurnSource>,
  ): Promise<void> {
    if (this.pendingResponseText) {
      const { html, plaintext } = markdownToMatrixHtml(
        this.pendingResponseText,
      );
      const finalText = plaintext + footer.text;
      const finalHtml = html + footer.html;
      let messageId: string | null = null;

      // If still pending, wait for it.
      if (this.streamState?.pendingMessageId) {
        await this.streamState.pendingMessageId;
      }

      const useStreamReplace =
        this.streamState && this.streamState.messageId !== "__pending__";

      if (useStreamReplace && this.streamState) {
        // Wait for rate-limit window to clear before replacing.
        const waitMs = this.streamState.pendingTimer
          ? this.streamState.currentInterval
          : Math.max(
              0,
              this.streamState.currentInterval -
                (Date.now() - this.streamState.lastEditAt),
            );
        if (this.streamState.pendingTimer)
          clearTimeout(this.streamState.pendingTimer);
        const streamMessageId = this.streamState.messageId;
        this.streamState = null;
        if (waitMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
        await this.deps.sender
          .edit(this.deps.chatId, streamMessageId, {
            text: finalText,
            html: finalHtml,
          })
          .catch(() => {});
        messageId = streamMessageId;
      } else {
        this.streamState = null;
        const sentEventId = await this.deps.sender
          .sendNew(this.deps.chatId, {
            text: finalText,
            html: finalHtml,
          })
          .catch(() => null);
        messageId = sentEventId ? String(sentEventId) : null;
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

  private async editStreamMessage(text: string): Promise<void> {
    const state = this.streamState;
    if (!state || state.messageId === "__pending__") return;
    try {
      await this.deps.sender.edit(this.deps.chatId, state.messageId, { text });
      state.lastEditAt = Date.now();
      state.lastText = text;
    } catch (error: unknown) {
      const errCode = (error as { errcode?: string }).errcode;
      if (errCode === "M_LIMIT_EXCEEDED") {
        state.currentInterval = Math.min(
          state.currentInterval * 2,
          MATRIX_STREAM_INTERVAL_MAX_MS,
        );
        if (state.pendingTimer) clearTimeout(state.pendingTimer);
        state.pendingTimer = setTimeout(() => {
          state.pendingTimer = null;
          void this.editStreamMessage(state.lastText);
        }, state.currentInterval);
      }
      // other errors: silently drop (streaming edit failures are non-fatal)
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
