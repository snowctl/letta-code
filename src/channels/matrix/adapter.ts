// src/channels/matrix/adapter.ts
import { join } from "node:path";
import { marked } from "marked";
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
  collectMatrixMediaCandidate,
  downloadMatrixAttachment,
  inferMimeTypeFromExtension,
  kindToMatrixMsgtype,
  MATRIX_DEFAULT_MAX_DOWNLOAD_BYTES,
} from "./media";
import {
  ensureMatrixCryptoUpToDate,
  loadMatrixBotSdkModule,
  loadMatrixCryptoModule,
} from "./runtime";

// ── Markdown helper ───────────────────────────────────────────────────────────

// Inlined here rather than imported from MessageChannel.ts to avoid the transitive import
// chain (registry → accounts → config) that conflicts with mock.module() in tests.
function markdownToMatrixHtml(text: string): string {
  return (marked.parse(text) as string).trimEnd();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  let running = false;

  // Per-adapter conv list cache keyed by chatId
  const convListCache = new Map<string, Conversation[]>();

  // Map from promptMessageEventId → PendingReactionRequest
  const pendingReactionRequests = new Map<string, PendingReactionRequest>();
  // Map from `${chatId}:${senderId}` → requestId
  const awaitingFreeformByChat = new Map<string, string>();

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
  const reasoningFlushIntervalByChatId = new Map<
    string,
    ReturnType<typeof setInterval>
  >();

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

  function startReasoningFlush(chatId: string): void {
    if (reasoningFlushIntervalByChatId.has(chatId)) return;
    let lastFlushed = "";
    let flushInProgress = false;
    const interval = setInterval(async () => {
      if (flushInProgress) return;
      const messageId = reasoningMessageIdByChatId.get(chatId);
      const buffer = reasoningBufferByChatId.get(chatId) ?? "";
      if (!messageId || messageId === "__pending__" || buffer === lastFlushed || !matrixClient) return;
      lastFlushed = buffer;
      flushInProgress = true;
      const html = `<details><summary>Thinking...</summary>\n${escapeHtml(buffer)}</details>`;
      await matrixClient
        .sendMessage(chatId, {
          msgtype: "m.text",
          body: "* Thinking...",
          format: "org.matrix.custom.html",
          "m.new_content": {
            msgtype: "m.text",
            body: "* Thinking...",
            format: "org.matrix.custom.html",
            formatted_body: html,
          },
          "m.relates_to": { rel_type: "m.replace", event_id: messageId },
        })
        .catch((error) => {
          console.warn(
            "[Matrix] Failed to flush reasoning:",
            error instanceof Error ? error.message : error,
          );
        })
        .finally(() => {
          flushInProgress = false;
        });
    }, 500);
    reasoningFlushIntervalByChatId.set(chatId, interval);
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
    reasoningMessageIdByChatId.delete(chatId);
    reasoningBufferByChatId.delete(chatId);
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
        if (!matrixClient) return;

        // Send thinking placeholder before tool block to guarantee ordering
        if (account.showReasoning !== false && !reasoningMessageIdByChatId.has(chatId)) {
          reasoningMessageIdByChatId.set(chatId, "__pending__");
          try {
            const eventId = await matrixClient.sendMessage(chatId, {
              msgtype: "m.text",
              body: "Thinking...",
              format: "org.matrix.custom.html",
              formatted_body: "<details><summary>Thinking...</summary></details>",
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
          const eventId = await matrixClient.sendMessage(chatId, {
            msgtype: "m.text",
            body: text,
          });
          toolBlockStateByChatId.set(chatId, {
            messageId: String(eventId),
            groups: newGroups,
          });
        } else {
          // Edit via m.relates_to / m.replace
          await matrixClient.sendMessage(chatId, {
            msgtype: "m.text",
            body: `* ${text}`,
            "m.new_content": { msgtype: "m.text", body: text },
            "m.relates_to": {
              rel_type: "m.replace",
              event_id: state.messageId,
            },
          });
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

    const {
      MatrixClient,
      SimpleFsStorageProvider,
      RustSdkCryptoStorageProvider,
      RustSdkCryptoStoreType,
    } = await loadMatrixBotSdkModule();

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
    const client = await ensureClient();
    for (const [, reactionEventId] of req.sentReactionEventIds) {
      try {
        await client.redactEvent(req.chatId, reactionEventId);
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
                await client
                  .sendMessage(roomIdStr, {
                    msgtype: "m.text",
                    body: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
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
          const httpUrl = client.mxcToHttp(candidate.mxcUrl);
          const attachment = await downloadMatrixAttachment(
            candidate,
            httpUrl,
            accountId,
            maxMediaDownloadBytes,
            transcribeVoice,
          );
          if (attachment) attachments.push(attachment);
        }

        const textContent = ((content.body as string | undefined) ?? "").trim();
        const isMediaOnly = candidate != null;

        if (!textContent && attachments.length === 0) return;

        const members = await client
          .getJoinedRoomMembers(roomIdStr)
          .catch(() => []);
        const chatType = members.length === 2 ? "direct" : "channel";

        const profile = await client
          .getUserProfile(senderIdStr)
          .catch(() => ({ displayname: undefined }));
        const senderName =
          (profile as { displayname?: string }).displayname ?? senderIdStr;

        const msg: InboundChannelMessage = {
          channel: "matrix",
          accountId,
          chatId: roomIdStr,
          senderId: senderIdStr,
          senderName,
          text: isMediaOnly ? "" : textContent,
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
      toolBlockStateByChatId.clear();
      toolBlockOperationByChatId.clear();
      for (const [, timer] of reasoningFlushIntervalByChatId) {
        clearInterval(timer);
      }
      reasoningFlushIntervalByChatId.clear();
      reasoningMessageIdByChatId.clear();
      reasoningBufferByChatId.clear();
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

      // Reaction add
      if (msg.reaction) {
        const eventId = await client.sendEvent(msg.chatId, "m.reaction", {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: msg.targetMessageId,
            key: msg.reaction,
          },
        });
        return { messageId: String(eventId) };
      }

      // Reaction remove
      if (msg.removeReaction && msg.targetMessageId) {
        const redactionId = await client.redactEvent(
          msg.chatId,
          msg.targetMessageId,
        );
        return { messageId: String(redactionId) };
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

      // Reasoning display — combine drawer + answer into one edited message
      const pendingReasoningMsgId = reasoningMessageIdByChatId.get(msg.chatId);
      if (pendingReasoningMsgId) {
        stopReasoningFlush(msg.chatId);
        // m.replace edits don't automatically clear the typing indicator on the
        // Matrix server (unlike new messages), so we stop it explicitly here.
        void stopTypingInterval(msg.chatId);
        const buffer = reasoningBufferByChatId.get(msg.chatId) ?? "";
        const answerHtml =
          msg.parseMode === "HTML"
            ? markdownToMatrixHtml(msg.text ?? "")
            : escapeHtml(msg.text ?? "");
        const html = `<details><summary>Thinking</summary>\n${escapeHtml(buffer)}</details><hr>${answerHtml}`;
        const plainFallback = `Thinking\n---\n${msg.text ?? ""}`;
        try {
          await client.sendMessage(msg.chatId, {
            msgtype: "m.text",
            body: plainFallback,
            format: "org.matrix.custom.html",
            "m.new_content": {
              msgtype: "m.text",
              body: plainFallback,
              format: "org.matrix.custom.html",
              formatted_body: html,
            },
            "m.relates_to": {
              rel_type: "m.replace",
              event_id: pendingReasoningMsgId,
            },
          });
          clearReasoningState(msg.chatId);
          return { messageId: pendingReasoningMsgId };
        } catch (error) {
          console.error(
            "[Matrix] Failed to write final reasoning+answer message, falling back to plain send:",
            error instanceof Error ? error.message : error,
          );
          clearReasoningState(msg.chatId);
          // fall through to normal sendMessage below
        }
      }

      // Plain text or HTML
      const content: Record<string, unknown> = {
        msgtype: "m.text",
        body: msg.text,
      };

      if (msg.parseMode === "HTML") {
        content.format = "org.matrix.custom.html";
        content.formatted_body = markdownToMatrixHtml(msg.text);
      }

      if (msg.replyToMessageId) {
        content["m.relates_to"] = {
          "m.in_reply_to": { event_id: msg.replyToMessageId },
        };
      }

      const eventId = await client.sendMessage(msg.chatId, content);
      return { messageId: String(eventId) };
    },

    async sendDirectReply(
      chatId: string,
      text: string,
      options?: { replyToMessageId?: string },
    ): Promise<void> {
      const client = await ensureClient();
      const content: Record<string, unknown> = {
        msgtype: "m.text",
        body: text,
      };
      if (options?.replyToMessageId) {
        content["m.relates_to"] = {
          "m.in_reply_to": { event_id: options.replyToMessageId },
        };
      }
      await client.sendMessage(chatId, content);
    },

    async handleControlRequestEvent(
      event: ChannelControlRequestEvent,
    ): Promise<void> {
      const client = await ensureClient();
      const { chatId, messageId, threadId } = event.source;

      const { promptText, emojis } = buildMatrixControlRequestPrompt(event);

      const replyContent: Record<string, unknown> = {
        msgtype: "m.text",
        body: promptText,
      };
      const replyToId = threadId ?? messageId;
      if (replyToId) {
        replyContent["m.relates_to"] = {
          "m.in_reply_to": { event_id: replyToId },
        };
      }

      const promptEventId = await client.sendMessage(chatId, replyContent);

      // Pre-react with all applicable emojis
      const sentReactionEventIds = new Map<string, string>();
      for (const emoji of emojis) {
        try {
          const reactionEventId = await client.sendEvent(chatId, "m.reaction", {
            "m.relates_to": {
              rel_type: "m.annotation",
              event_id: promptEventId,
              key: emoji,
            },
          });
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
        }
        return;
      }

      if (event.type === "tool_call") {
        if (event.toolName === "MessageChannel") return;
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
        await stopTypingInterval(source.chatId);

        const pending = toolBlockOperationByChatId.get(source.chatId);
        if (pending) await pending.catch(() => {});
        toolBlockStateByChatId.delete(source.chatId);
        toolBlockOperationByChatId.delete(source.chatId);

        // Redact thinking placeholder if turn ended without a response.
        // If the placeholder send is still in-flight, wait briefly for it to resolve.
        let reasoningMsgId = reasoningMessageIdByChatId.get(source.chatId);
        if (reasoningMsgId === "__pending__") {
          const deadline = Date.now() + 2000;
          while (
            reasoningMessageIdByChatId.get(source.chatId) === "__pending__" &&
            Date.now() < deadline
          ) {
            await new Promise<void>((r) => setTimeout(r, 50));
          }
          reasoningMsgId = reasoningMessageIdByChatId.get(source.chatId);
        }
        if (reasoningMsgId && reasoningMsgId !== "__pending__" && matrixClient) {
          await matrixClient.redactEvent(source.chatId, reasoningMsgId).catch((error) => {
            console.warn(
              "[Matrix] Failed to redact thinking placeholder on turn end:",
              error instanceof Error ? error.message : error,
            );
          });
        }

        clearReasoningState(source.chatId);
      }
    },

    async handleStreamReasoning(
      chunk: string,
      sources: ChannelTurnSource[],
    ): Promise<void> {
      if (account.showReasoning === false) return;
      const client = await ensureClient();

      for (const source of sources) {
        const { chatId } = source;
        reasoningBufferByChatId.set(
          chatId,
          (reasoningBufferByChatId.get(chatId) ?? "") + chunk,
        );

        if (!reasoningMessageIdByChatId.has(chatId)) {
          reasoningMessageIdByChatId.set(chatId, "__pending__"); // claim the slot immediately
          try {
            const eventId = await client.sendMessage(chatId, {
              msgtype: "m.text",
              body: "Thinking...",
              format: "org.matrix.custom.html",
              formatted_body: "<details><summary>Thinking...</summary></details>",
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
        getChannelRegistry()
          ?.getRoute("matrix", chatId, accountId)
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
          getChannelRegistry()
            ?.getRoute("matrix", chatId, accountId)
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
    };
    return handleOperatorCommand(command, args, opCtx);
  }

  async function handleBotCommand(
    roomId: string,
    body: string,
    _event: Record<string, unknown>,
  ): Promise<void> {
    const client = await ensureClient();
    const parts = body.trim().split(/\s+/);
    const command = parts[0]?.toLowerCase();

    if (command === "!start") {
      await client.sendMessage(roomId, {
        msgtype: "m.text",
        body: "Hi! I'm a Letta AI assistant.\n\nTo pair this conversation with an agent, ask your admin for a pairing code and send it here.",
      });
      return;
    }

    if (command === "!status") {
      await client.sendMessage(roomId, {
        msgtype: "m.text",
        body: `Bot: ${userId}\nDM Policy: ${dmPolicy}`,
      });
      return;
    }

    if (command === "!cancel") {
      const reply = await dispatchOperatorCommand("cancel", [], roomId);
      await client.sendMessage(roomId, { msgtype: "m.text", body: reply });
      return;
    }

    if (command === "!compact") {
      const reply = await dispatchOperatorCommand("compact", [], roomId);
      await client.sendMessage(roomId, { msgtype: "m.text", body: reply });
      return;
    }

    if (command === "!recompile") {
      const reply = await dispatchOperatorCommand("recompile", [], roomId);
      await client.sendMessage(roomId, { msgtype: "m.text", body: reply });
      return;
    }

    if (command === "!conv") {
      const args = parts.slice(1).filter(Boolean);
      const reply = await dispatchOperatorCommand("conv", args, roomId);
      await client.sendMessage(roomId, { msgtype: "m.text", body: reply });
      return;
    }

    if (command === "!help") {
      const reply = await dispatchOperatorCommand("help", [], roomId);
      await client.sendMessage(roomId, { msgtype: "m.text", body: reply });
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
        const client = await ensureClient();
        pending.awaitingFreeform = true;
        const freeformKey = buildFreeformKey(roomId, senderIdStr);
        awaitingFreeformByChat.set(freeformKey, pending.requestId);
        const followUpText =
          pending.kind === "ask_user_question"
            ? "Please type your answer:"
            : "Please type your reason for denying:";
        await client.sendMessage(roomId, {
          msgtype: "m.text",
          body: followUpText,
        });
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
        inputStr.length > 1200 ? inputStr.slice(0, 1197) + "..." : inputStr;
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
            ? event.planContent.slice(0, 1797) + "..."
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
