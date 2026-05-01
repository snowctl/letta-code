// src/channels/matrix/adapter.ts
import { join } from "node:path";
import type { Letta } from "@letta-ai/letta-client";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { getClient } from "../../agent/client";
import { getChannelDir } from "../config";
import { formatChannelControlRequestPrompt } from "../interactive";
import {
  handleOperatorCommand,
  type OperatorCommandContext,
} from "../operator-commands";
import { getChannelRegistry } from "../registry";
import {
  renderToolBlock,
  type ToolCallGroup,
  upsertToolCallGroup,
} from "../tool-block";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelControlRequestKind,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  InboundChannelMessage,
  MatrixChannelAccount,
  OutboundChannelMessage,
} from "../types";
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
import { MatrixSender } from "./matrixSender";
import {
  collectMatrixMediaCandidate,
  downloadMatrixAttachment,
  inferMimeTypeFromExtension,
  kindToMatrixMsgtype,
  MATRIX_DEFAULT_MAX_DOWNLOAD_BYTES,
} from "./media";
import {
  ensureMatrixCryptoUpToDate,
  type LegacyRequestCallback,
  type LegacyRequestParams,
  type LegacyRequestResponse,
  loadMatrixBotSdkModule,
  loadMatrixCryptoModule,
  loadUndiciModule,
  type UndiciDispatcher,
  type UndiciLike,
} from "./runtime";

// ── HTTP transport ────────────────────────────────────────────────────────────
// matrix-bot-sdk@0.8.0 ships with the deprecated `request` library. Its
// `timeout` option is implemented via socket-level timer events on Node's `net`
// module — which Bun polyfills imperfectly — so a stalled `/sync` long-poll
// can hang past its 40 s timeout and never recover. The fetch-based
// replacement below uses AbortSignal-driven timeouts at the JS event-loop
// level, which works identically under Node and Bun.
//
// Why undici instead of the platform `fetch`: Bun's built-in fetch keeps
// connections alive in an internal pool we cannot tune. In production we
// observed sockets that the homeserver (or an intermediate proxy) silently
// closed during an idle window staying in Bun's pool as "alive"; every
// reuse then hung until our AbortSignal fired, producing exact-on-timeout
// errors in tight bursts and silencing the matrix channel for hours.
// undici exposes a `keepAliveTimeout` knob — we set it tighter than any
// reasonable proxy idle timeout (10 s) so undici evicts pooled sockets
// before the server can quietly close them out from under us. We keep
// pooling on for tight intra-sync bursts (e.g. fetching room state),
// which are well within the 10 s window. Installed via `setRequestFn`
// in `createClient()`.

function buildLegacyRequestUrl(params: LegacyRequestParams): string {
  if (!params.qs) return params.uri;
  const url = new URL(params.uri);
  for (const [key, value] of Object.entries(params.qs)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      // matrix-bot-sdk passes `useQuerystring: true, arrayFormat: "repeat"`,
      // which means `?key=v1&key=v2`. URLSearchParams.append matches that.
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Module-scoped lazy singletons. One Agent and one fetch reference shared
 *  across every matrix adapter instance in this process. */
let cachedUndici: UndiciLike | null = null;
let cachedDispatcher: UndiciDispatcher | null = null;

async function getUndiciDispatcher(): Promise<{
  undici: UndiciLike;
  dispatcher: UndiciDispatcher;
}> {
  if (cachedUndici && cachedDispatcher) {
    return { undici: cachedUndici, dispatcher: cachedDispatcher };
  }
  const undici = await loadUndiciModule();
  // Tight idle-eviction values: any pooled socket idle longer than
  // keepAliveTimeout is closed by undici before the server's idle-close
  // can leave it stale in our pool. keepAliveMaxTimeout caps the absolute
  // age of any pooled socket. bodyTimeout is a belt on top of our own
  // AbortSignal so a half-open response can't hang silently.
  // headersTimeout is intentionally omitted: Matrix sync long-polling holds
  // connections open for 30 s before sending any response headers, which
  // would cause a 15 s headersTimeout to fire on every sync cycle.
  const dispatcher = new undici.Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 30_000,
    bodyTimeout: 65_000,
    connect: { timeout: 10_000 },
  });
  cachedUndici = undici;
  cachedDispatcher = dispatcher;
  return { undici, dispatcher };
}

function makeFetchBackedRequestFn(
  undici: UndiciLike,
  dispatcher: UndiciDispatcher,
) {
  return async function fetchBackedRequestFn(
    params: LegacyRequestParams,
    callback: LegacyRequestCallback,
  ): Promise<void> {
    const timeoutMs = params.timeout > 0 ? params.timeout : 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new Error(`matrix-bot-sdk request timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    // Buffer is fetch-compatible at runtime (Node + Bun), but TS's BodyInit
    // doesn't list it; copy out into a fresh ArrayBuffer so the type matches.
    let requestBody: BodyInit | undefined;
    if (params.body === undefined) {
      requestBody = undefined;
    } else if (typeof params.body === "string") {
      requestBody = params.body;
    } else {
      const slice = params.body.buffer.slice(
        params.body.byteOffset,
        params.body.byteOffset + params.body.byteLength,
      );
      requestBody = slice as ArrayBuffer;
    }

    try {
      const response = await undici.fetch(buildLegacyRequestUrl(params), {
        method: params.method,
        headers: params.headers,
        body: requestBody,
        signal: controller.signal,
        dispatcher,
      });
      const buf = Buffer.from(await response.arrayBuffer());
      const responseBody: string | Buffer =
        params.encoding === null ? buf : buf.toString("utf-8");
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const responseLike: LegacyRequestResponse = {
        statusCode: response.status,
        headers,
        body: responseBody,
      };
      callback(null, responseLike, responseBody);
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── Markdown helper ───────────────────────────────────────────────────────────

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

// ── Control request state ─────────────────────────────────────────────────────

const KEYCAP_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

type AskUserQuestionInput = {
  questions?: Array<{
    question?: string;
    options?: Array<{ label?: string; description?: string }>;
    multiSelect?: boolean;
  }>;
};

type PendingReactionRequest = {
  requestId: string;
  kind: ChannelControlRequestKind;
  chatId: string;
  senderId: string | null;
  sentEmojis: string[];
  sentReactionEventIds: Map<string, string>;
  awaitingFreeform: boolean;
};

// ── MatrixClient local interface ──────────────────────────────────────────────

interface MatrixClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: string, handler: (...args: unknown[]) => unknown): this;
  sendMessage(roomId: string, content: unknown): Promise<string>;
  sendEvent(roomId: string, type: string, content: unknown): Promise<string>;
  redactEvent(roomId: string, eventId: string): Promise<string>;
  joinRoom(roomId: string): Promise<string>;
  uploadContent(
    data: Buffer,
    contentType: string,
    filename: string,
  ): Promise<string>;
  mxcToHttp(mxc: string): string;
  downloadContent(
    mxcUrl: string,
  ): Promise<{ data: Buffer; contentType: string }>;
  getUserProfile(userId: string): Promise<{ displayname?: string }>;
  getJoinedRoomMembers(roomId: string): Promise<string[]>;
  setTyping(roomId: string, isTyping: boolean, timeout?: number): Promise<void>;
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

  let matrixClient: MatrixClientLike | null = null;
  let sender: MatrixSender | null = null;
  let running = false;

  // Per-adapter conv list cache keyed by chatId
  const convListCache = new Map<string, Conversation[]>();

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

  // ── Inbound metadata cache ────────────────────────────────────────
  // getJoinedRoomMembers is an HTTP round-trip to the homeserver, used
  // only to determine chatType (direct vs channel). Membership rarely
  // changes between messages, so cache with a short TTL and invalidate
  // on m.room.member state events. Display names are not fetched at
  // all — the agent gets senderId, which is unique and sufficient.
  const MEMBERS_CACHE_TTL_MS = 5 * 60 * 1000;
  const roomMembersCache = new Map<
    string,
    { members: string[]; expiresAt: number }
  >();

  async function getRoomMembersCached(
    client: MatrixClientLike,
    roomId: string,
  ): Promise<string[]> {
    const now = Date.now();
    const hit = roomMembersCache.get(roomId);
    if (hit && hit.expiresAt > now) return hit.members;
    const members = await client.getJoinedRoomMembers(roomId).catch(() => []);
    roomMembersCache.set(roomId, {
      members,
      expiresAt: now + MEMBERS_CACHE_TTL_MS,
    });
    return members;
  }

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

  async function createClient(): Promise<MatrixClientLike> {
    // If the installed crypto-nodejs predates 0.5.0, it can't expose the
    // cross-signing upload requests. Upgrade before loading the SDK.
    await ensureMatrixCryptoUpToDate();

    const matrixBotSdk = await loadMatrixBotSdkModule();

    // Replace matrix-bot-sdk's deprecated `request` library with an undici-
    // backed fetch shim. AbortSignal-driven timeouts replace the legacy lib's
    // broken socket-level timer, and undici's `Agent` gives us the pool-
    // eviction knobs Bun's built-in fetch lacks (see top of file). The
    // dispatcher is module-scoped and reused across createClient() calls,
    // so a respawn of the same agent doesn't churn pools.
    const { undici, dispatcher } = await getUndiciDispatcher();
    matrixBotSdk.setRequestFn(makeFetchBackedRequestFn(undici, dispatcher));

    const {
      MatrixClient,
      SimpleFsStorageProvider,
      RustSdkCryptoStorageProvider,
      RustSdkCryptoStoreType,
    } = matrixBotSdk;

    const channelDir = getChannelDir("matrix");
    const storageDir = join(channelDir, accountId);
    const storagePath = join(storageDir, "storage.json");
    const cryptoPath = join(storageDir, "crypto");

    const storageProvider = new SimpleFsStorageProvider(storagePath);

    let cryptoProvider: unknown;
    if (e2ee) {
      try {
        // matrix-bot-sdk@0.8.0's JS doesn't re-export RustSdkCryptoStoreType
        // even though the .d.ts claims it does. Load StoreType directly from
        // @matrix-org/matrix-sdk-crypto-nodejs as the primary source, and fall
        // back to whatever matrix-bot-sdk exports (in case a future version
        // does re-export it). Sled was renamed to Sqlite in crypto-nodejs ≥ 0.3.
        let storeValue: string | number | undefined =
          RustSdkCryptoStoreType?.Sqlite ?? RustSdkCryptoStoreType?.Sled;

        if (storeValue === undefined) {
          const cryptoMod = await loadMatrixCryptoModule();
          storeValue = cryptoMod.StoreType?.Sqlite ?? cryptoMod.StoreType?.Sled;
        }

        if (storeValue === undefined) {
          throw new Error(
            "StoreType not available from matrix-bot-sdk or @matrix-org/matrix-sdk-crypto-nodejs",
          );
        }

        cryptoProvider = new RustSdkCryptoStorageProvider(
          cryptoPath,
          storeValue,
        );
      } catch (err) {
        console.warn(
          "[matrix] E2EE unavailable (Rust crypto addon failed to load); running unencrypted:",
          err,
        );
      }
    }

    return new (
      MatrixClient as unknown as new (
        homeserverUrl: string,
        accessToken: string,
        storageProvider: unknown,
        cryptoProvider?: unknown,
      ) => MatrixClientLike
    )(homeserverUrl, accessToken, storageProvider, cryptoProvider);
  }

  async function ensureClient(): Promise<MatrixClientLike> {
    if (!matrixClient) throw new Error("Matrix adapter not started");
    return matrixClient;
  }

  function buildFreeformKey(chatId: string, senderId: string): string {
    return `${chatId}:${senderId}`;
  }

  async function redactControlRequestReactions(
    req: PendingReactionRequest,
  ): Promise<void> {
    if (!sender) return;
    for (const [, reactionEventId] of req.sentReactionEventIds) {
      try {
        await sender.redact(req.chatId, reactionEventId);
      } catch {
        // best-effort cleanup
      }
    }
  }

  const adapter: ChannelAdapter = {
    id: `matrix:${accountId}`,
    channelId: "matrix",
    accountId,
    name: "Matrix",

    async start(): Promise<void> {
      matrixClient = await createClient();
      sender = new MatrixSender(matrixClient);
      const client = matrixClient;

      // Auto-accept room invites
      client.on("room.invite", async (roomId: unknown) => {
        try {
          await client.joinRoom(roomId as string);
        } catch (err) {
          console.warn(`[matrix] Failed to join room ${roomId}:`, err);
        }
      });

      // Text messages and media
      client.on("room.message", async (roomId: unknown, event: unknown) => {
        const roomIdStr = roomId as string;
        const eventObj = event as Record<string, unknown>;
        if (eventObj.sender === userId) return;

        const content = eventObj.content as Record<string, unknown> | undefined;
        if (!content) return;
        const msgtype = content.msgtype as string | undefined;

        // Bot commands
        if (msgtype === "m.text" || msgtype === "m.notice") {
          const body = (content.body as string | undefined)?.trim() ?? "";
          if (body.startsWith("!")) {
            await handleBotCommand(roomIdStr, body, eventObj).catch(
              async (err) => {
                await sender
                  ?.sendNew(roomIdStr, {
                    text: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
                  })
                  .catch(() => {});
              },
            );
            return;
          }
        }

        // Check freeform awaiting
        const senderIdStr = eventObj.sender as string;
        const freeformKey = buildFreeformKey(roomIdStr, senderIdStr);
        const pendingId = awaitingFreeformByChat.get(freeformKey);
        if (pendingId) {
          const pendingEntry = [...pendingReactionRequests.entries()].find(
            ([, v]) => v.requestId === pendingId,
          );
          if (pendingEntry) {
            awaitingFreeformByChat.delete(freeformKey);
            pendingReactionRequests.delete(pendingEntry[0]);
            await redactControlRequestReactions(pendingEntry[1]);
          }
          // Fall through: emit as normal message so registry handles it as freeform response
        }

        // Attachments
        const candidate = collectMatrixMediaCandidate(eventObj);
        const attachments = [];
        if (candidate) {
          let mediaBuffer: Buffer | null = null;
          try {
            const { data } = await client.downloadContent(candidate.mxcUrl);
            mediaBuffer = data;
          } catch (err) {
            console.warn(
              "[Matrix] Failed to download media:",
              err instanceof Error ? err.message : err,
            );
          }
          if (mediaBuffer) {
            const attachment = await downloadMatrixAttachment(
              candidate,
              mediaBuffer,
              accountId,
              maxMediaDownloadBytes,
              transcribeVoice,
            );
            if (attachment) attachments.push(attachment);
          }
        }

        const body = ((content.body as string | undefined) ?? "").trim();
        // Suppress body text for any media-type event: either the candidate
        // was parsed and body equals the filename (Matrix sends the filename
        // as body by default), OR the candidate failed to parse (malformed
        // E2EE / missing URL) in which case body is still just the filename.
        const isMediaMsgtype = [
          "m.image",
          "m.video",
          "m.audio",
          "m.file",
        ].includes(msgtype ?? "");
        const textContent =
          (candidate && body === candidate.filename) ||
          (!candidate && isMediaMsgtype)
            ? ""
            : body;

        if (!textContent && attachments.length === 0) return;

        // Start typing before the member-lookup network call so the indicator
        // appears immediately rather than after the round-trip completes.
        startTypingInterval(roomIdStr);

        const members = await getRoomMembersCached(client, roomIdStr);
        const chatType = members.length === 2 ? "direct" : "channel";

        const msg: InboundChannelMessage = {
          channel: "matrix",
          accountId,
          chatId: roomIdStr,
          senderId: senderIdStr,
          text: textContent,
          timestamp: Date.now(),
          messageId: eventObj.event_id as string | undefined,
          chatType,
          attachments: attachments.length > 0 ? attachments : undefined,
        };

        await adapter.onMessage?.(msg);
      });

      // Reactions and redactions
      client.on("room.event", async (roomId: unknown, event: unknown) => {
        const roomIdStr = roomId as string;
        const eventObj = event as Record<string, unknown>;
        const type = eventObj.type as string;

        if (type === "m.reaction") {
          await handleReactionEvent(roomIdStr, eventObj);
          return;
        }

        if (type === "m.room.redaction") {
          await handleRedactionEvent(roomIdStr, eventObj);
          return;
        }

        // Invalidate the room-members cache on membership state changes
        // so the next inbound message picks up the new member count.
        if (type === "m.room.member") {
          roomMembersCache.delete(roomIdStr);
          return;
        }
      });

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
      convListCache.clear();

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
        const eventId = await sender!.edit(msg.chatId, msg.editTargetMessageId, {
          text: plaintext,
          html,
        });
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
        const redactionId = await sender!.redact(msg.chatId, msg.targetMessageId);
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
      const { chatId, messageId, threadId } = event.source;

      const { promptText, emojis } = buildMatrixControlRequestPrompt(event);

      const { html, plaintext } = markdownToMatrixHtml(promptText);
      const replyToId = threadId ?? messageId;
      const promptEventId = await sender!.sendNew(chatId, {
        text: plaintext,
        html,
        replyToMessageId: replyToId ?? undefined,
      });

      // Pre-react with all applicable emojis
      const sentReactionEventIds = new Map<string, string>();
      for (const emoji of emojis) {
        try {
          const reactionEventId = await sender!.sendReaction(
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

  // ── Internal helpers ──────────────────────────────────────────────────────

  async function dispatchOperatorCommand(
    command: string,
    args: string[],
    chatId: string,
  ): Promise<string> {
    if (command === "help") {
      return handleOperatorCommand("help", [], {
        commandPrefix: "!",
        agentId: "",
        chatId,
        client: {} as Letta,
        getCurrentConvId: () => "default",
        setCurrentConvId: async () => {},
        requestCancel: () => false,
        getConvListCache: () => null,
        setConvListCache: () => {},
      });
    }
    const registry = getChannelRegistry();
    const route = registry?.getRoute("matrix", chatId, accountId);
    if (!route) return "This chat is not connected to an agent.";
    const client = await getClient();
    const opCtx: OperatorCommandContext = {
      agentId: route.agentId,
      chatId,
      commandPrefix: "!",
      client,
      getCurrentConvId: () =>
        getChannelRegistry()?.getRoute("matrix", chatId, accountId)
          ?.conversationId ?? "default",
      setCurrentConvId: async (id) => {
        getChannelRegistry()?.updateRouteConversation(
          "matrix",
          chatId,
          accountId,
          id,
        );
      },
      requestCancel: () => {
        const liveConvId =
          getChannelRegistry()?.getRoute("matrix", chatId, accountId)
            ?.conversationId ?? "default";
        return registry?.cancelActiveRun(route.agentId, liveConvId) ?? false;
      },
      getConvListCache: () => convListCache.get(chatId) ?? null,
      setConvListCache: (list) => {
        if (list === null) {
          convListCache.delete(chatId);
        } else {
          convListCache.set(chatId, list);
        }
      },
      onContextWindowChange: (size) => {
        const liveConvId =
          getChannelRegistry()?.getRoute("matrix", chatId, accountId)
            ?.conversationId ?? "default";
        getChannelRegistry()?.updateContextWindowMax(
          route.agentId,
          liveConvId,
          size,
        );
      },
    };
    return handleOperatorCommand(command, args, opCtx);
  }

  async function handleBotCommand(
    roomId: string,
    body: string,
    _event: Record<string, unknown>,
  ): Promise<void> {
    await ensureClient();
    const parts = body.trim().split(/\s+/);
    const command = parts[0]?.toLowerCase();

    if (command === "!start") {
      await sender!.sendNew(roomId, {
        text: "Hi! I'm a Letta AI assistant.\n\nTo pair this conversation with an agent, ask your admin for a pairing code and send it here.",
      });
      return;
    }

    if (command === "!status") {
      await sender!.sendNew(roomId, {
        text: `Bot: ${userId}\nDM Policy: ${dmPolicy}`,
      });
      return;
    }

    const sendReply = async (text: string) => {
      const { html, plaintext } = markdownToMatrixHtml(text);
      await sender!.sendNew(roomId, {
        text: plaintext,
        html,
      });
    };

    if (command === "!cancel") {
      await sendReply(await dispatchOperatorCommand("cancel", [], roomId));
      return;
    }

    if (command === "!compact") {
      await sendReply(await dispatchOperatorCommand("compact", [], roomId));
      return;
    }

    if (command === "!recompile") {
      await sendReply(await dispatchOperatorCommand("recompile", [], roomId));
      return;
    }

    if (command === "!conv") {
      const args = parts.slice(1).filter(Boolean);
      await sendReply(await dispatchOperatorCommand("conv", args, roomId));
      return;
    }

    if (command === "!reset") {
      const args = parts.slice(1).filter(Boolean);
      await sendReply(await dispatchOperatorCommand("reset", args, roomId));
      return;
    }

    if (command === "!models") {
      await sendReply(await dispatchOperatorCommand("models", [], roomId));
      return;
    }

    if (command === "!model") {
      const args = parts.slice(1).filter(Boolean);
      await sendReply(await dispatchOperatorCommand("model", args, roomId));
      return;
    }

    if (command === "!ctx") {
      const args = parts.slice(1).filter(Boolean);
      await sendReply(await dispatchOperatorCommand("ctx", args, roomId));
      return;
    }

    if (command === "!help") {
      await sendReply(await dispatchOperatorCommand("help", [], roomId));
      return;
    }
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
        await ensureClient();
        pending.awaitingFreeform = true;
        const freeformKey = buildFreeformKey(roomId, senderIdStr);
        awaitingFreeformByChat.set(freeformKey, pending.requestId);
        const followUpText =
          pending.kind === "ask_user_question"
            ? "Please type your answer:"
            : "Please type your reason for denying:";
        await sender!.sendNew(roomId, { text: followUpText });
        return;
      }

      const syntheticText = emojiToSyntheticText(emoji);
      if (!syntheticText) return;

      pendingReactionRequests.delete(targetEventId);
      await redactControlRequestReactions(pending);

      const client = await ensureClient();
      const members = await client.getJoinedRoomMembers(roomId).catch(() => []);
      const chatType = members.length === 2 ? "direct" : "channel";

      await adapter.onMessage?.({
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
    await adapter.onMessage?.({
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

  return adapter;
}

// ── Control request prompt builder ────────────────────────────────────────────

function buildMatrixControlRequestPrompt(event: ChannelControlRequestEvent): {
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

function emojiToSyntheticText(emoji: string): string | null {
  if (emoji === "✅") return "approve";
  if (emoji === "❌") return "deny";
  const keycapIndex = KEYCAP_EMOJIS.indexOf(emoji);
  if (keycapIndex !== -1) return String(keycapIndex + 1);
  return null;
}
