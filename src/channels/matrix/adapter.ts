// src/channels/matrix/adapter.ts
import {
  renderToolBlock,
  type ToolCallGroup,
  upsertToolCallGroup,
} from "../tool-block";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  MatrixChannelAccount,
  OutboundChannelMessage,
} from "../types";
import { createBotCommands } from "./botCommands";
import { createMatrixBotSdkClient, type MatrixBotSdkClient } from "./client";
import {
  createControlRequests,
  type PendingReactionRequest,
} from "./controlRequests";
import { ensureCrossSigning } from "./crossSigning";
import {
  buildArgsPreview,
  clipReasoningForMatrix,
  escapeHtml,
  formatCompact,
  formatElapsed,
  markdownToMatrixHtml,
  redactSecrets,
} from "./htmlFormat";
import {
  makeRoomEventHandler,
  makeRoomMessageHandler,
  RoomMembersCache,
} from "./inbound";
import { MatrixSender } from "./matrixSender";
import {
  inferMimeTypeFromExtension,
  kindToMatrixMsgtype,
  MATRIX_DEFAULT_MAX_DOWNLOAD_BYTES,
} from "./media";

// ── Tool-progress UX threshold ────────────────────────────────────────────────
// Tools that finish inside this window leave no trace in the chat — no running
// block, no took-annotation. Anything longer renders the live progress UI and
// the took-annotation when it ends. 1 s strikes a balance between hiding noise
// from instant local ops (Read, Glob, etc.) and surfacing real waits.
let toolProgressGraceMs = 1_000;

/** Test-only override of the grace window. Production code must not call this. */
export function __testSetToolProgressGraceMs(ms: number): void {
  toolProgressGraceMs = ms;
}

// ── Adapter factory ───────────────────────────────────────────────────────────

export function createMatrixAdapter(
  account: MatrixChannelAccount,
): ChannelAdapter {
  const {
    homeserverUrl,
    accessToken,
    userId,
    accountId,
    dmPolicy,
    transcribeVoice = false,
    maxMediaDownloadBytes = MATRIX_DEFAULT_MAX_DOWNLOAD_BYTES,
    e2ee,
  } = account;

  let matrixClient: MatrixBotSdkClient | null = null;
  let sender: MatrixSender | null = null;
  let running = false;
  let membersCache: RoomMembersCache | null = null;
  let botCommandsApi: ReturnType<typeof createBotCommands> | null = null;
  let controlRequestsApi: ReturnType<typeof createControlRequests> | null =
    null;

  // Map from promptMessageEventId → PendingReactionRequest
  const pendingReactionRequests = new Map<string, PendingReactionRequest>();
  // Map from `${chatId}:${senderId}` → requestId
  const awaitingFreeformByChat = new Map<string, string>();

  // ── Streaming state ──────────────────────────────────────────────
  const MATRIX_STREAM_INTERVAL_MS = 500;
  const MATRIX_STREAM_INTERVAL_MAX_MS = 8_000;

  interface MatrixStreamState {
    messageId: string;
    /** Resolves to the real messageId (or null on failure) once the initial
     *  sendMessage call settles. Set only while messageId === "__pending__". */
    pendingMessageId: Promise<string | null> | null;
    lastText: string;
    lastEditAt: number;
    pendingTimer: ReturnType<typeof setTimeout> | null;
    currentInterval: number;
    cleanupTimeout: ReturnType<typeof setTimeout> | null;
  }
  const streamStates = new Map<string, MatrixStreamState>();

  // ── Typing indicator state ────────────────────────────────────────
  const typingIntervalByChatId = new Map<
    string,
    ReturnType<typeof setInterval>
  >();

  // ── Tool block state ─────────────────────────────────────────────
  interface MatrixToolBlockState {
    messageId: string;
    groups: ToolCallGroup[];
  }
  const toolBlockStateByChatId = new Map<string, MatrixToolBlockState>();
  const toolBlockOperationByChatId = new Map<string, Promise<void>>();

  // ── Reasoning display state ───────────────────────────────────────────────
  const reasoningMessageIdByChatId = new Map<string, string>();
  const reasoningBufferByChatId = new Map<string, string>();
  // Set when a tool call interrupts reasoning; causes next chunk to prepend \n--\n separator
  const reasoningNeedsSeparatorByChatId = new Set<string>();
  const reasoningFlushIntervalByChatId = new Map<
    string,
    ReturnType<typeof setInterval>
  >();

  // ── Live tool-progress state ──────────────────────────────────────────────
  // Tracks the currently-executing tool per chat so the thinking placeholder
  // shows "Running `Bash` · 0:32 / 2:00" with a ticking elapsed counter
  // instead of looking frozen during long tool runs. The most recently
  // ended tool stays visible as a "Bash took 1:47" annotation until the
  // next tool starts or reasoning resumes — gives the user a record of how
  // long each step took.
  //
  // Tools that complete inside `toolProgressGraceMs` are *invisible*: the
  // running block is never shown and no took-annotation is left behind.
  // This keeps the room from flashing "Running `Read` · 0:00" for 200 ms
  // every time the agent inspects a file. The grace also covers the
  // took-annotation: if the running block never appeared, neither does
  // the receipt.
  interface RunningToolState {
    toolCallId: string;
    toolName: string;
    argsPreview: string;
    timeoutMs?: number;
    startedAt: number;
  }
  interface CompletedToolState {
    toolName: string;
    argsPreview: string;
    durationMs: number;
    outcome: "success" | "error";
  }
  const runningToolByChatId = new Map<string, RunningToolState>();
  const lastCompletedToolByChatId = new Map<string, CompletedToolState>();
  const toolProgressTickerByChatId = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  // Per-chat grace timer: pending until either the timer fires (running block
  // becomes visible) or tool_ended arrives first (state cleared silently).
  const toolProgressGraceTimerByChatId = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  // Tracks when the current turn entered "processing" state. Used to compute
  // total turn wall time for the completion footer.
  const turnStartedAtByChatId = new Map<string, number>();

  // Stores the last plain-text response sent during the current turn, per
  // chatId. The "finished" handler edits this message to append the completion
  // footer.
  const lastResponseByChatId = new Map<
    string,
    { eventId: string; text: string; html: string }
  >();

  // Text stored by handleAutoForward; sent by the "finished" lifecycle handler after
  // thinking-block finalization to maintain correct Matrix timeline order.
  const pendingResponseTextByChatId = new Map<string, string>();
  const lastSentMessageIdByConversationId = new Map<string, string>();

  // ── Typing interval helpers ───────────────────────────────────────

  function startTypingInterval(chatId: string): void {
    if (typingIntervalByChatId.has(chatId) || !matrixClient) return;
    const fire = () => {
      if (!matrixClient) return;
      void matrixClient.setTyping(chatId, true, 8000).catch(() => {});
    };
    fire();
    typingIntervalByChatId.set(chatId, setInterval(fire, 4000));
  }

  async function stopTypingInterval(chatId: string): Promise<void> {
    const timer = typingIntervalByChatId.get(chatId);
    if (timer !== undefined) {
      clearInterval(timer);
      typingIntervalByChatId.delete(chatId);
      if (matrixClient) {
        await matrixClient.setTyping(chatId, false).catch(() => {});
      }
    }
  }

  /** Build the running-tool block HTML (or null if nothing to render). */
  function buildToolStatusHtml(chatId: string): string | null {
    const running = runningToolByChatId.get(chatId);
    if (running) {
      const elapsed = formatElapsed(Date.now() - running.startedAt);
      const deadline = running.timeoutMs
        ? ` / ${formatElapsed(running.timeoutMs)}`
        : "";
      const args = escapeHtml(running.argsPreview);
      return `<b>Running <code>${escapeHtml(running.toolName)}</code> · ${elapsed}${deadline}</b><br><blockquote><code>${args}</code></blockquote>`;
    }
    const completed = lastCompletedToolByChatId.get(chatId);
    if (completed) {
      const took = formatElapsed(completed.durationMs);
      const verb = completed.outcome === "error" ? "errored after" : "took";
      const args = escapeHtml(completed.argsPreview);
      return `<i><code>${escapeHtml(completed.toolName)}</code> ${verb} ${took}</i><br><blockquote><code>${args}</code></blockquote>`;
    }
    return null;
  }

  /** Build the full thinking-placeholder HTML: reasoning buffer plus the
   *  current tool-status block (running or just-completed) when present.
   *  Returns `null` when there's nothing meaningful to flush — the
   *  placeholder was already created with the bare "Thinking..." HTML, so
   *  emitting that again would be a wasted edit. */
  function buildPlaceholderHtml(chatId: string): string | null {
    const rawBuffer = reasoningBufferByChatId.get(chatId) ?? "";
    const buffer = clipReasoningForMatrix(rawBuffer);
    const reasoningHtml = buffer
      ? `<b>Thinking...</b><br><blockquote>${escapeHtml(buffer)
          .replace(/\n--\n/g, "<hr>")
          .replace(/\n/g, "<br>")}</blockquote>`
      : "";
    const toolHtml = buildToolStatusHtml(chatId);
    if (reasoningHtml && toolHtml) return `${reasoningHtml}${toolHtml}`;
    if (toolHtml) return toolHtml;
    if (reasoningHtml) return reasoningHtml;
    return null;
  }

  /** Edit the existing thinking-placeholder message with fresh HTML.
   *  No-op when there's no active placeholder or matrix client. */
  async function editPlaceholder(chatId: string, html: string): Promise<void> {
    if (!sender) return;
    const messageId = reasoningMessageIdByChatId.get(chatId);
    if (!messageId || messageId === "__pending__") return;
    await sender
      .edit(chatId, messageId, { text: "Thinking...", html })
      .catch((error) => {
        console.warn(
          "[Matrix] Failed to edit placeholder:",
          error instanceof Error ? error.message : error,
        );
      });
  }

  function startReasoningFlush(chatId: string): void {
    if (reasoningFlushIntervalByChatId.has(chatId)) return;
    let lastFlushed: string | null = null;
    let flushInProgress = false;
    const interval = setInterval(async () => {
      if (flushInProgress) return;
      const messageId = reasoningMessageIdByChatId.get(chatId);
      if (!messageId || messageId === "__pending__" || !matrixClient) return;
      const html = buildPlaceholderHtml(chatId);
      if (html === null) return; // nothing meaningful yet — leave bare "Thinking..."
      // Dedupe identical edits — avoids a tight stream of no-op `m.replace`
      // events when neither reasoning nor tool state has changed.
      if (html === lastFlushed) return;
      lastFlushed = html;
      flushInProgress = true;
      await editPlaceholder(chatId, html).finally(() => {
        flushInProgress = false;
      });
    }, 150);
    reasoningFlushIntervalByChatId.set(chatId, interval);
  }

  // ── Stream edit helper ────────────────────────────────────────────

  async function editStreamMessage(
    roomId: string,
    text: string,
  ): Promise<void> {
    const state = streamStates.get(roomId);
    if (!state || !sender || state.messageId === "__pending__") return;
    try {
      await sender.edit(roomId, state.messageId, { text });
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
          void editStreamMessage(roomId, state.lastText);
        }, state.currentInterval);
      }
      // other errors: silently drop (streaming edit failures are non-fatal)
    }
  }

  /** Ensure a thinking-placeholder message exists for this chat, creating one
   *  if it doesn't. Used at tool_started for tools that fire before any
   *  reasoning content has arrived (e.g. immediate tool calls). */
  async function ensureThinkingPlaceholder(chatId: string): Promise<void> {
    if (!sender) return;
    if (reasoningMessageIdByChatId.has(chatId)) return; // already exists or pending
    reasoningMessageIdByChatId.set(chatId, "__pending__");
    try {
      const eventId = await sender.sendNew(chatId, {
        text: "Thinking...",
        html: "<b>Thinking...</b>",
      });
      reasoningMessageIdByChatId.set(chatId, String(eventId));
      startReasoningFlush(chatId);
    } catch (error) {
      reasoningMessageIdByChatId.delete(chatId);
      console.warn(
        "[Matrix] Failed to create placeholder for tool progress:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** Start the per-chat ticker that bumps the running-tool elapsed timer
   *  every 5 s. Idempotent. */
  function startToolProgressTicker(chatId: string): void {
    if (toolProgressTickerByChatId.has(chatId)) return;
    const ticker = setInterval(async () => {
      if (!runningToolByChatId.has(chatId)) {
        stopToolProgressTicker(chatId);
        return;
      }
      const html = buildPlaceholderHtml(chatId);
      if (html === null) return;
      await editPlaceholder(chatId, html);
    }, 5_000);
    toolProgressTickerByChatId.set(chatId, ticker);
  }

  function stopToolProgressTicker(chatId: string): void {
    const ticker = toolProgressTickerByChatId.get(chatId);
    if (ticker !== undefined) {
      clearInterval(ticker);
      toolProgressTickerByChatId.delete(chatId);
    }
  }

  function stopReasoningFlush(chatId: string): void {
    const interval = reasoningFlushIntervalByChatId.get(chatId);
    if (interval !== undefined) {
      clearInterval(interval);
      reasoningFlushIntervalByChatId.delete(chatId);
    }
  }

  function clearReasoningState(chatId: string): void {
    stopReasoningFlush(chatId);
    stopToolProgressTicker(chatId);
    const graceTimer = toolProgressGraceTimerByChatId.get(chatId);
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      toolProgressGraceTimerByChatId.delete(chatId);
    }
    reasoningMessageIdByChatId.delete(chatId);
    reasoningBufferByChatId.delete(chatId);
    reasoningNeedsSeparatorByChatId.delete(chatId);
    runningToolByChatId.delete(chatId);
    lastCompletedToolByChatId.delete(chatId);
    lastResponseByChatId.delete(chatId);
    turnStartedAtByChatId.delete(chatId);
    pendingResponseTextByChatId.delete(chatId);
  }

  async function finalizeReasoningMessage(
    chatId: string,
    footer?: { html: string; text: string },
  ): Promise<void> {
    const messageId = reasoningMessageIdByChatId.get(chatId);
    if (!messageId || messageId === "__pending__" || !sender) return;
    const rawBuffer = reasoningBufferByChatId.get(chatId) ?? "";
    // Skip if nothing to show and no footer to append.
    if (!rawBuffer && !footer) return;
    // Clip to Matrix's 64 KiB-per-event limit; keep the most recent thinking
    // (sliding window) since the early portion is usually already implied
    // by tool calls + the final answer.
    const buffer = clipReasoningForMatrix(rawBuffer);
    const innerHtml =
      (buffer
        ? escapeHtml(buffer)
            .replace(/\n--\n/g, "<hr>")
            .replace(/\n/g, "<br>")
        : "") + (footer ? `<hr>${footer.html}` : "");
    const html = `<b>Thinking</b><br><blockquote>${innerHtml}</blockquote>`;
    const plainText = `Thinking\n${buffer}${footer ? `\n${footer.text}` : ""}`;
    await sender
      .edit(chatId, messageId, { text: plainText, html })
      .catch((error: unknown) => {
        console.warn(
          "[Matrix] Failed to finalize reasoning message:",
          error instanceof Error ? error.message : error,
        );
      });
  }

  async function waitForPendingPlaceholder(chatId: string): Promise<void> {
    if (reasoningMessageIdByChatId.get(chatId) !== "__pending__") return;
    const deadline = Date.now() + 2000;
    while (
      reasoningMessageIdByChatId.get(chatId) === "__pending__" &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  // ── Tool block helper ─────────────────────────────────────────────

  function scheduleToolBlockUpdate(
    chatId: string,
    toolName: string,
    description?: string,
  ): void {
    const previous =
      toolBlockOperationByChatId.get(chatId) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        if (!sender) return;

        // Send thinking placeholder before tool block to guarantee ordering
        if (
          account.showReasoning !== false &&
          !reasoningMessageIdByChatId.has(chatId)
        ) {
          reasoningMessageIdByChatId.set(chatId, "__pending__");
          try {
            const eventId = await sender.sendNew(chatId, {
              text: "Thinking...",
              html: "<b>Thinking...</b>",
            });
            reasoningMessageIdByChatId.set(chatId, String(eventId));
            startReasoningFlush(chatId);
          } catch (error) {
            reasoningMessageIdByChatId.delete(chatId);
            console.warn(
              "[Matrix] Failed to send thinking placeholder:",
              error instanceof Error ? error.message : error,
            );
          }
        }

        const state = toolBlockStateByChatId.get(chatId);
        const newGroups = upsertToolCallGroup(
          state?.groups ?? [],
          toolName,
          description,
        );
        const text = renderToolBlock(newGroups);

        if (!state) {
          // Send new message
          const eventId = await sender.sendNew(chatId, { text });
          toolBlockStateByChatId.set(chatId, {
            messageId: String(eventId),
            groups: newGroups,
          });
        } else {
          // Edit via m.relates_to / m.replace
          await sender.edit(chatId, state.messageId, { text });
          toolBlockStateByChatId.set(chatId, {
            messageId: state.messageId,
            groups: newGroups,
          });
        }
      })
      .catch((error) => {
        console.warn(
          `[Matrix] Failed to update tool block for ${chatId}:`,
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        if (toolBlockOperationByChatId.get(chatId) === operation) {
          toolBlockOperationByChatId.delete(chatId);
        }
      });
    toolBlockOperationByChatId.set(chatId, operation);
  }

  async function ensureClient(): Promise<MatrixBotSdkClient> {
    if (!matrixClient) throw new Error("Matrix adapter not started");
    return matrixClient;
  }

  const adapter: ChannelAdapter = {
    id: `matrix:${accountId}`,
    channelId: "matrix",
    accountId,
    name: "Matrix",

    async start(): Promise<void> {
      matrixClient = await createMatrixBotSdkClient({
        homeserverUrl,
        accessToken,
        accountId,
        e2ee: !!e2ee,
      });
      sender = new MatrixSender(matrixClient);
      const client = matrixClient;

      membersCache = new RoomMembersCache();
      botCommandsApi = createBotCommands({
        sender,
        account,
        accountId,
        userId,
        dmPolicy,
      });
      controlRequestsApi = createControlRequests({
        sender,
        client: matrixClient,
        pendingReactionRequests,
        awaitingFreeformByChat,
        getOnMessage: () => adapter.onMessage,
        userId,
        accountId,
      });

      // Auto-accept room invites
      client.on("room.invite", async (roomId: unknown) => {
        try {
          await client.joinRoom(roomId as string);
        } catch (err) {
          console.warn(`[matrix] Failed to join room ${roomId}:`, err);
        }
      });

      const mc = membersCache;
      const bc = botCommandsApi;

      // Text messages and media
      client.on(
        "room.message",
        makeRoomMessageHandler({
          client: matrixClient,
          account,
          accountId,
          userId,
          sender,
          membersCache: mc,
          pendingReactionRequests,
          awaitingFreeformByChat,
          startTyping: (chatId) => startTypingInterval(chatId),
          redactControlRequestReactions:
            controlRequestsApi.redactControlRequestReactions,
          handleBotCommand: bc.handleBotCommand,
          getOnMessage: () => adapter.onMessage,
          transcribeVoice,
          maxMediaDownloadBytes,
        }),
      );

      // Reactions and redactions
      client.on(
        "room.event",
        makeRoomEventHandler({
          membersCache: mc,
          handleReactionEvent: controlRequestsApi.handleReactionEvent,
          handleRedactionEvent: controlRequestsApi.handleRedactionEvent,
        }),
      );

      await client.start();

      // Ensure the bot's own device is cross-signed by its owner's SSK so
      // Element X doesn't show "Encrypted by a device not verified by its
      // owner" on every bot message. Idempotent; no-op after first success.
      if (e2ee) {
        try {
          const outcome = await ensureCrossSigning(
            client as unknown as Parameters<typeof ensureCrossSigning>[0],
            homeserverUrl,
            accessToken,
          );
          if (outcome === "bootstrapped") {
            console.log(
              `[matrix] cross-signing bootstrapped for ${userId} — Element X should now show verified shield`,
            );
          }
        } catch (err) {
          console.warn(
            `[matrix] cross-signing bootstrap failed for ${userId} (continuing; will retry on next start):`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      running = true;
    },

    async stop(): Promise<void> {
      // Clean up typing intervals
      for (const [chatId, timer] of typingIntervalByChatId) {
        clearInterval(timer);
        if (matrixClient) {
          await matrixClient.setTyping(chatId, false).catch(() => {});
        }
      }
      typingIntervalByChatId.clear();
      for (const state of streamStates.values()) {
        if (state.pendingTimer) clearTimeout(state.pendingTimer);
        if (state.cleanupTimeout) clearTimeout(state.cleanupTimeout);
      }
      streamStates.clear();
      toolBlockStateByChatId.clear();
      toolBlockOperationByChatId.clear();
      for (const [, timer] of reasoningFlushIntervalByChatId) {
        clearInterval(timer);
      }
      reasoningFlushIntervalByChatId.clear();
      reasoningMessageIdByChatId.clear();
      reasoningBufferByChatId.clear();
      reasoningNeedsSeparatorByChatId.clear();
      for (const [, timer] of toolProgressTickerByChatId) {
        clearInterval(timer);
      }
      toolProgressTickerByChatId.clear();
      for (const [, timer] of toolProgressGraceTimerByChatId) {
        clearTimeout(timer);
      }
      toolProgressGraceTimerByChatId.clear();
      runningToolByChatId.clear();
      lastCompletedToolByChatId.clear();
      lastResponseByChatId.clear();
      turnStartedAtByChatId.clear();
      pendingResponseTextByChatId.clear();
      botCommandsApi?.getConvListCache().clear();
      membersCache?.clear();

      await matrixClient?.stop();
      running = false;
    },

    isRunning(): boolean {
      return running;
    },

    async sendMessage(
      msg: OutboundChannelMessage,
    ): Promise<{ messageId: string }> {
      const client = await ensureClient();

      // Edit existing message via m.replace. The edit must be one the bot
      // itself sent — Matrix homeservers reject m.replace events whose
      // sender doesn't match the original. We don't enforce that here; the
      // homeserver will fail the request and the error surfaces back to
      // the agent.
      if (msg.editTargetMessageId) {
        const { html, plaintext } = markdownToMatrixHtml(msg.text);
        const eventId = await sender!.edit(
          msg.chatId,
          msg.editTargetMessageId,
          {
            text: plaintext,
            html,
          },
        );
        return { messageId: eventId };
      }

      // Reaction add
      if (msg.reaction) {
        const eventId = await sender!.sendReaction(
          msg.chatId,
          msg.targetMessageId!,
          msg.reaction,
        );
        return { messageId: String(eventId) };
      }

      // Reaction remove
      if (msg.removeReaction && msg.targetMessageId) {
        const redactionId = await sender!.redact(
          msg.chatId,
          msg.targetMessageId,
        );
        return { messageId: redactionId };
      }

      // Media upload
      if (msg.mediaPath) {
        const buffer = Buffer.from(await Bun.file(msg.mediaPath).arrayBuffer());
        const filename =
          msg.fileName ?? msg.mediaPath.split("/").pop() ?? "file";
        const mimeType = inferMimeTypeFromExtension(filename);
        const mxcUrl = await client.uploadContent(buffer, mimeType, filename);
        const msgtype = kindToMatrixMsgtype(mimeType);
        const eventId = await client.sendMessage(msg.chatId, {
          msgtype,
          body: msg.title ?? filename,
          url: mxcUrl,
          info: { mimetype: mimeType, size: buffer.byteLength },
        });
        return { messageId: String(eventId) };
      }

      // Drain all pending tool block operations to ensure tool block messages are above the response.
      while (toolBlockOperationByChatId.has(msg.chatId)) {
        await toolBlockOperationByChatId.get(msg.chatId)?.catch(() => {});
      }

      // If handleStreamReasoning is currently sending the thinking placeholder (__pending__),
      // wait for it to land before sending the response — otherwise the response arrives first
      // and the thinking block ends up below it in the Matrix timeline.
      await waitForPendingPlaceholder(msg.chatId);

      // Reasoning state is intentionally NOT finalized here — thinking continues after tool calls
      // (including ChannelAction). Finalization happens only at the "finished" lifecycle event.
      void stopTypingInterval(msg.chatId);

      // Always convert markdown to HTML for proper Matrix rendering
      const { html, plaintext } = markdownToMatrixHtml(msg.text);

      // If a streaming preview message exists, replace it with the final
      // canonical message instead of sending a new one.
      const streamState = streamStates.get(msg.chatId);
      if (streamState && streamState.messageId !== "__pending__") {
        if (streamState.cleanupTimeout)
          clearTimeout(streamState.cleanupTimeout);
        if (streamState.pendingTimer) clearTimeout(streamState.pendingTimer);
        streamStates.delete(msg.chatId);
        await sender!.edit(msg.chatId, streamState.messageId, {
          text: plaintext,
          html,
        });

        // Track for completion footer
        lastResponseByChatId.set(msg.chatId, {
          eventId: streamState.messageId,
          text: msg.text,
          html,
        });
        return { messageId: streamState.messageId };
      }

      const eventId = await sender!.sendNew(msg.chatId, {
        text: plaintext,
        html,
        replyToMessageId: msg.replyToMessageId,
      });

      // Record the last plain-text response for the completion footer.
      lastResponseByChatId.set(msg.chatId, {
        eventId: String(eventId),
        text: msg.text,
        html,
      });

      return { messageId: String(eventId) };
    },

    async sendDirectReply(
      chatId: string,
      text: string,
      options?: { replyToMessageId?: string },
    ): Promise<void> {
      await ensureClient();
      const { html, plaintext } = markdownToMatrixHtml(text);
      await sender!.sendNew(chatId, {
        text: plaintext,
        html,
        replyToMessageId: options?.replyToMessageId,
      });
    },

    async handleAutoForward(
      text: string,
      sources: ChannelTurnSource[],
    ): Promise<string | undefined> {
      // Deferred: store text for the "finished" lifecycle handler to send
      // after finalizeReasoningMessage() to maintain Matrix timeline order.
      for (const source of sources) {
        // If sendMessage (ChannelAction/NotifyUser) already delivered a message
        // this turn, lastResponseByChatId is set. Skip storing pending text so
        // the "finished" handler uses the lastResponse fallback to append the
        // footer — avoiding a duplicate post when accumulatedChannelText from a
        // prior segment is carried into runtime.finalAssistantText.
        if (!lastResponseByChatId.has(source.chatId)) {
          pendingResponseTextByChatId.set(source.chatId, text);
        }
      }
      return undefined;
    },

    getLastSentMessageId(conversationId: string): string | null {
      return lastSentMessageIdByConversationId.get(conversationId) ?? null;
    },

    async handleControlRequestEvent(
      event: ChannelControlRequestEvent,
    ): Promise<void> {
      await ensureClient();
      await controlRequestsApi!.handleControlRequestEvent(event);
    },

    async handleTurnLifecycleEvent(
      event: ChannelTurnLifecycleEvent,
    ): Promise<void> {
      if (!running) return;

      if (event.type === "queued") {
        startTypingInterval(event.source.chatId);
        return;
      }

      if (event.type === "processing") {
        for (const source of event.sources) {
          startTypingInterval(source.chatId);
          turnStartedAtByChatId.set(source.chatId, Date.now());
        }
        return;
      }

      if (event.type === "tool_started") {
        // ChannelAction and NotifyUser are outbound channel tools, not user-visible
        // work. Skip live progress for them.
        if (
          event.toolName === "ChannelAction" ||
          event.toolName === "NotifyUser"
        )
          return;
        const argsPreview = buildArgsPreview(event.toolName, event.args);
        for (const source of event.sources) {
          const { chatId } = source;
          runningToolByChatId.set(chatId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            argsPreview,
            timeoutMs: event.timeoutMs,
            startedAt: Date.now(),
          });
          // Defer rendering by toolProgressGraceMs. If tool_ended arrives
          // first, the grace timer is cancelled and nothing is ever shown
          // for this tool — fast tools (Read, Glob, etc.) stay invisible.
          const graceTimer = setTimeout(() => {
            toolProgressGraceTimerByChatId.delete(chatId);
            // A new tool starting clears the "took m:ss" annotation from the
            // previous one. We do this *here* (when we commit to showing
            // the running block) rather than in tool_started, so a fast
            // tool that gets suppressed doesn't disrupt a stale annotation
            // that's still useful context.
            lastCompletedToolByChatId.delete(chatId);
            void (async () => {
              await ensureThinkingPlaceholder(chatId);
              const html = buildPlaceholderHtml(chatId);
              if (html !== null) await editPlaceholder(chatId, html);
            })();
            startToolProgressTicker(chatId);
          }, toolProgressGraceMs);
          toolProgressGraceTimerByChatId.set(chatId, graceTimer);
        }
        return;
      }

      if (event.type === "tool_ended") {
        if (
          event.toolName === "ChannelAction" ||
          event.toolName === "NotifyUser"
        )
          return;
        for (const source of event.sources) {
          const { chatId } = source;
          const running = runningToolByChatId.get(chatId);
          // Only act on the matching tool call — guards against late arrivals
          // when a follow-up tool already replaced the running state.
          if (!running || running.toolCallId !== event.toolCallId) continue;
          runningToolByChatId.delete(chatId);
          // If the grace timer is still pending, the running block was never
          // rendered. Cancel it and exit silently — no annotation either.
          const graceTimer = toolProgressGraceTimerByChatId.get(chatId);
          if (graceTimer !== undefined) {
            clearTimeout(graceTimer);
            toolProgressGraceTimerByChatId.delete(chatId);
            continue;
          }
          stopToolProgressTicker(chatId);
          lastCompletedToolByChatId.set(chatId, {
            toolName: event.toolName,
            argsPreview: running.argsPreview,
            durationMs: event.durationMs,
            outcome: event.outcome,
          });
          // Push the "took m:ss" annotation immediately. Subsequent reasoning
          // flushes (if the agent keeps thinking) keep the annotation visible
          // until the next tool_started clears it.
          const html = buildPlaceholderHtml(chatId);
          if (html !== null) void editPlaceholder(chatId, html);
        }
        return;
      }

      if (event.type === "tool_call") {
        // Any tool call interrupts the reasoning stream.
        // Mark that the next reasoning chunk should prepend a separator.
        for (const source of event.sources) {
          if (reasoningMessageIdByChatId.has(source.chatId)) {
            reasoningNeedsSeparatorByChatId.add(source.chatId);
          }
        }
        if (
          event.toolName === "ChannelAction" ||
          event.toolName === "NotifyUser"
        )
          return;
        for (const source of event.sources) {
          scheduleToolBlockUpdate(
            source.chatId,
            event.toolName,
            event.description,
          );
        }
        return;
      }

      // "finished"
      for (const source of event.sources) {
        const { chatId } = source;
        await stopTypingInterval(chatId);

        const pending = toolBlockOperationByChatId.get(chatId);
        if (pending) await pending.catch(() => {});
        toolBlockStateByChatId.delete(chatId);
        toolBlockOperationByChatId.delete(chatId);

        await waitForPendingPlaceholder(chatId);
        stopReasoningFlush(chatId);

        // Capture turn state before clearReasoningState() deletes both Maps.
        const startedAt = turnStartedAtByChatId.get(chatId);
        const durationMs = startedAt !== undefined ? Date.now() - startedAt : 0;
        const durationStr = formatElapsed(durationMs);
        const lastResponse = lastResponseByChatId.get(chatId);
        const reasoningMsgId = reasoningMessageIdByChatId.get(chatId);
        const hasThinkingBlock =
          !!reasoningMsgId && reasoningMsgId !== "__pending__";

        if (event.outcome === "completed") {
          const pendingText = pendingResponseTextByChatId.get(chatId);
          pendingResponseTextByChatId.delete(chatId);

          // Finalize thinking block first, then send response below it.
          await finalizeReasoningMessage(chatId);
          clearReasoningState(chatId);

          const eventUsage =
            event.type === "finished" ? event.usage : undefined;
          const showUsage =
            account.showContextUsage !== false &&
            eventUsage &&
            eventUsage.contextTokens > 0 &&
            eventUsage.contextWindowMax > 0;
          const usageSuffix = showUsage
            ? ` · ${formatCompact(eventUsage.contextTokens)} / ${formatCompact(eventUsage.contextWindowMax)} tokens`
            : "";
          const usageHtml = showUsage
            ? ` <span data-mx-color="#8b949e">· ${formatCompact(eventUsage.contextTokens)} / ${formatCompact(eventUsage.contextWindowMax)} tokens</span>`
            : "";

          // Build footer content once, used in both branches below.
          const footerHtml =
            `<hr><span data-mx-color="#3fb950">✓</span> ` +
            `<span data-mx-color="#8b949e">completed in ${durationStr}</span>${usageHtml}`;
          const footerText = `\n✓ completed in ${durationStr}${usageSuffix}`;

          if (pendingText && sender) {
            const { html, plaintext } = markdownToMatrixHtml(pendingText);

            // If there is a streaming preview for this room, replace it with
            // the final formatted content instead of sending a second message.
            // If the initial sendMessage is still in-flight (__pending__), wait
            // for it — otherwise the else branch posts a duplicate message.
            if (streamStates.get(chatId)?.pendingMessageId) {
              await streamStates.get(chatId)?.pendingMessageId;
            }
            const streamState = streamStates.get(chatId);
            const useStreamReplace =
              streamState && streamState.messageId !== "__pending__";

            let messageId: string | null = null;

            if (useStreamReplace) {
              // Wait for the rate-limit window to clear before replacing the
              // stream preview. editStreamMessage throttles edits to
              // currentInterval ms, but the finished handler fires immediately
              // after the turn ends — so the stream-replace can arrive at the
              // homeserver within milliseconds of the last streaming edit and
              // get silently dropped with M_LIMIT_EXCEEDED.
              const waitMs = streamState.pendingTimer
                ? streamState.currentInterval // was already rate-limited; wait the full backoff
                : Math.max(
                    0,
                    streamState.currentInterval -
                      (Date.now() - streamState.lastEditAt),
                  );
              if (streamState.pendingTimer)
                clearTimeout(streamState.pendingTimer);
              if (streamState.cleanupTimeout)
                clearTimeout(streamState.cleanupTimeout);
              streamStates.delete(chatId);
              if (waitMs > 0) {
                await new Promise<void>((resolve) =>
                  setTimeout(resolve, waitMs),
                );
              }
              await sender
                .edit(chatId, streamState.messageId, {
                  text: plaintext + footerText,
                  html: html + footerHtml,
                })
                .catch((err: unknown) => {
                  console.warn(
                    "[Matrix] handleAutoForward stream-replace failed:",
                    err instanceof Error ? err.message : err,
                  );
                });
              messageId = streamState.messageId;
            } else {
              const sentEventId = await sender
                .sendNew(chatId, {
                  text: plaintext + footerText,
                  html: html + footerHtml,
                })
                .catch((err: unknown) => {
                  console.warn(
                    "[Matrix] handleAutoForward send failed:",
                    err instanceof Error ? err.message : err,
                  );
                  return null;
                });
              messageId = sentEventId ? String(sentEventId) : null;
            }

            if (messageId) {
              // Track for ChannelAction edits
              const source = event.sources.find((s) => s.chatId === chatId);
              if (source) {
                lastSentMessageIdByConversationId.set(
                  source.conversationId,
                  messageId,
                );
              }
            }
          } else if (lastResponse && sender) {
            // Fallback: no pending text from auto-forward (e.g. ChannelAction already sent
            // a message this turn, or streaming preview exists but pendingText was skipped
            // by the guard). Edit the lastResponse message to append the footer.
            await sender
              .edit(chatId, lastResponse.eventId, {
                text: lastResponse.text + footerText,
                html: lastResponse.html + footerHtml,
              })
              .catch((err: unknown) => {
                console.warn(
                  "[Matrix] Failed to append completion footer:",
                  err instanceof Error ? err.message : err,
                );
              });
          }
        } else if (event.outcome === "error") {
          pendingResponseTextByChatId.delete(chatId);
          const errorDetail = event.error ? `: ${event.error}` : "";
          const footerHtml =
            `<span data-mx-color="#f85149">⚠ Turn failed</span>` +
            `<span data-mx-color="#8b949e"> · tool error${escapeHtml(errorDetail)}</span>`;
          const footerText = `⚠ Turn failed · tool error${errorDetail}`;

          if (hasThinkingBlock) {
            await finalizeReasoningMessage(chatId, {
              html: footerHtml,
              text: footerText,
            });
            clearReasoningState(chatId);
          } else {
            clearReasoningState(chatId);
            const fallbackDetail = event.error
              ? `: ${event.error}`
              : " — the turn didn't complete.";
            await sender
              ?.sendNew(chatId, {
                text: `⚠ Turn failed${fallbackDetail}`,
                html:
                  `<span data-mx-color="#f85149">⚠ Turn failed</span>` +
                  `<span data-mx-color="#8b949e">${escapeHtml(fallbackDetail)}</span>`,
              })
              .catch(() => {});
          }
        } else {
          // "cancelled"
          pendingResponseTextByChatId.delete(chatId);
          if (hasThinkingBlock) {
            const footerHtml = `<span data-mx-color="#e3b341">· Cancelled</span>`;
            const footerText = "· Cancelled";
            await finalizeReasoningMessage(chatId, {
              html: footerHtml,
              text: footerText,
            });
          } else {
            await finalizeReasoningMessage(chatId);
          }
          clearReasoningState(chatId);
        }

        // Clean up any dangling streaming state (e.g. silent turn never sent
        // a final sendMessage that would have replaced the stream message).
        const streamState = streamStates.get(chatId);
        if (streamState) {
          if (streamState.pendingTimer) clearTimeout(streamState.pendingTimer);
          if (streamState.cleanupTimeout)
            clearTimeout(streamState.cleanupTimeout);
          streamStates.delete(chatId);
        }
      }
    },

    async handleStreamReasoning(
      chunk: string,
      sources: ChannelTurnSource[],
    ): Promise<void> {
      if (account.showReasoning === false) return;
      await ensureClient();

      for (const source of sources) {
        const { chatId } = source;

        // A tool call interrupted reasoning since last chunk — prepend separator
        if (reasoningNeedsSeparatorByChatId.has(chatId)) {
          reasoningNeedsSeparatorByChatId.delete(chatId);
          const existing = reasoningBufferByChatId.get(chatId) ?? "";
          if (existing)
            reasoningBufferByChatId.set(chatId, `${existing}\n--\n`);
        }

        const _existing = reasoningBufferByChatId.get(chatId) ?? "";
        // Insert a space between chunks when the buffer ends with a sentence
        // terminator and the new chunk starts with a non-whitespace character
        // (kimi-k2.6 streams reasoning without inter-sentence spaces).
        const _spacer =
          _existing.length > 0 && /[.!?]$/.test(_existing) && /^\S/.test(chunk)
            ? " "
            : "";
        reasoningBufferByChatId.set(chatId, _existing + _spacer + chunk);

        if (!reasoningMessageIdByChatId.has(chatId)) {
          reasoningMessageIdByChatId.set(chatId, "__pending__"); // claim the slot immediately
          try {
            const eventId = await sender!.sendNew(chatId, {
              text: "Thinking...",
              html: "<b>Thinking...</b>",
            });
            reasoningMessageIdByChatId.set(chatId, String(eventId));
            startReasoningFlush(chatId);
          } catch (error) {
            reasoningMessageIdByChatId.delete(chatId); // allow retry on error
            console.warn(
              "[Matrix] Failed to send initial reasoning message:",
              error instanceof Error ? error.message : error,
            );
          }
        }
      }
    },

    async handleStreamText(
      accumulatedText: string,
      sources: ChannelTurnSource[],
    ): Promise<void> {
      if (!running || !sender) return;

      for (const source of sources) {
        const roomId = source.chatId;
        const existing = streamStates.get(roomId);

        if (!existing) {
          // Claim the slot synchronously before the async send to prevent a
          // race where concurrent void-dispatched calls each see !existing and
          // each create a separate initial message.
          let resolvePendingMessageId: (id: string | null) => void = () => {};
          const sentinel: MatrixStreamState = {
            messageId: "__pending__",
            pendingMessageId: new Promise<string | null>((resolve) => {
              resolvePendingMessageId = resolve;
            }),
            lastText: accumulatedText,
            lastEditAt: Date.now(),
            pendingTimer: null,
            currentInterval: MATRIX_STREAM_INTERVAL_MS,
            cleanupTimeout: null,
          };
          streamStates.set(roomId, sentinel);
          await stopTypingInterval(roomId);
          try {
            const eventId = await sender.sendNew(roomId, {
              text: accumulatedText,
            });
            sentinel.messageId = String(eventId);
            sentinel.pendingMessageId = null;
            resolvePendingMessageId(String(eventId));
            // If more text arrived while the initial sendMessage was in flight,
            // send an immediate edit so the latest content is visible right away
            // instead of waiting for the next handleStreamText call + interval check.
            if (sentinel.lastText !== accumulatedText) {
              sentinel.lastEditAt = Date.now();
              void editStreamMessage(roomId, sentinel.lastText);
            }
          } catch (error) {
            streamStates.delete(roomId);
            resolvePendingMessageId(null);
            console.error(
              "[Matrix] Initial stream post failed:",
              error instanceof Error ? error.message : error,
            );
          }
          continue;
        }

        // Still waiting for the initial sendMessage to resolve — keep latest text.
        if (existing.messageId === "__pending__") {
          existing.lastText = accumulatedText;
          continue;
        }

        existing.lastText = accumulatedText;
        const elapsed = Date.now() - existing.lastEditAt;

        if (elapsed >= existing.currentInterval) {
          if (existing.pendingTimer) {
            clearTimeout(existing.pendingTimer);
            existing.pendingTimer = null;
          }
          void editStreamMessage(roomId, accumulatedText);
        } else {
          if (existing.pendingTimer) clearTimeout(existing.pendingTimer);
          existing.pendingTimer = setTimeout(() => {
            existing.pendingTimer = null;
            void editStreamMessage(roomId, existing.lastText);
          }, existing.currentInterval - elapsed);
        }
      }
    },

    async handleStreamReset(sources: ChannelTurnSource[]): Promise<void> {
      if (!running) return;
      for (const source of sources) {
        const state = streamStates.get(source.chatId);
        if (state) {
          if (state.pendingTimer) clearTimeout(state.pendingTimer);
          if (state.cleanupTimeout) clearTimeout(state.cleanupTimeout);
          // Delete the stream state so the next segment posts a fresh Matrix
          // message. This ensures the post-tool response appears after the
          // tool block in the timeline, not before it.
          streamStates.delete(source.chatId);
        }
      }
    },

    onMessage: undefined,
  };

  return adapter;
}
