// src/channels/matrix/adapter.ts
import { join } from "node:path";
import { marked } from "marked";
import { getChannelDir } from "../config";
import { formatChannelControlRequestPrompt } from "../interactive";
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
import {
  collectMatrixMediaCandidate,
  downloadMatrixAttachment,
  inferMimeTypeFromExtension,
  kindToMatrixMsgtype,
  MATRIX_DEFAULT_MAX_DOWNLOAD_BYTES,
} from "./media";
import { loadMatrixBotSdkModule } from "./runtime";

// ── Markdown helper ───────────────────────────────────────────────────────────

// Inlined here rather than imported from MessageChannel.ts to avoid the transitive import
// chain (registry → accounts → config) that conflicts with mock.module() in tests.
function markdownToMatrixHtml(text: string): string {
  return (marked.parse(text) as string).trimEnd();
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

  // Map from promptMessageEventId → PendingReactionRequest
  const pendingReactionRequests = new Map<string, PendingReactionRequest>();
  // Map from `${chatId}:${senderId}` → requestId
  const awaitingFreeformByChat = new Map<string, string>();

  // ── Typing indicator state ────────────────────────────────────────
  const typingIntervalByChatId = new Map<string, ReturnType<typeof setInterval>>();

  // ── Streaming state ──────────────────────────────────────────────
  const MATRIX_STREAM_INTERVAL_MS = 500;
  const MATRIX_STREAM_INTERVAL_MAX_MS = 8000;

  interface MatrixStreamState {
    messageId: string;
    lastText: string;
    lastEditAt: number;
    pendingTimer: ReturnType<typeof setTimeout> | null;
    currentInterval: number;
    cleanupTimeout: ReturnType<typeof setTimeout> | null;
  }
  const streamStates = new Map<string, MatrixStreamState>();

  // ── Tool block state ─────────────────────────────────────────────
  interface MatrixToolBlockState {
    messageId: string;
    groups: ToolCallGroup[];
  }
  const toolBlockStateByChatId = new Map<string, MatrixToolBlockState>();
  const toolBlockOperationByChatId = new Map<string, Promise<void>>();

  // ── Typing interval helpers ───────────────────────────────────────

  function startTypingInterval(chatId: string): void {
    if (typingIntervalByChatId.has(chatId) || !matrixClient) return;
    const fire = () => {
      if (!matrixClient) return;
      void matrixClient.sendTyping(chatId, true, 8000).catch(() => {});
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
        await matrixClient.sendTyping(chatId, false).catch(() => {});
      }
    }
  }

  // ── Stream edit helper ────────────────────────────────────────────

  async function editStreamMessage(roomId: string, text: string): Promise<void> {
    const state = streamStates.get(roomId);
    if (!state || !matrixClient) return;
    try {
      await matrixClient.sendEvent(roomId, "m.room.message", {
        "m.new_content": { msgtype: "m.text", body: text },
        "m.relates_to": { rel_type: "m.replace", event_id: state.messageId },
        body: "[editing…]",
      });
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

  // ── Tool block helper ─────────────────────────────────────────────

  function scheduleToolBlockUpdate(chatId: string, toolName: string, description?: string): void {
    const previous = toolBlockOperationByChatId.get(chatId) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        if (!matrixClient) return;
        const state = toolBlockStateByChatId.get(chatId);
        const newGroups = upsertToolCallGroup(state?.groups ?? [], toolName, description);
        const text = renderToolBlock(newGroups);

        if (!state) {
          // Send new message
          const eventId = await matrixClient.sendMessage(chatId, {
            msgtype: "m.text",
            body: text,
          });
          toolBlockStateByChatId.set(chatId, { messageId: String(eventId), groups: newGroups });
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
          toolBlockStateByChatId.set(chatId, { messageId: state.messageId, groups: newGroups });
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
        cryptoProvider = new RustSdkCryptoStorageProvider(
          cryptoPath,
          RustSdkCryptoStoreType.Sled,
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
            await handleBotCommand(roomIdStr, body, eventObj);
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
      running = true;
    },

    async stop(): Promise<void> {
      // Clean up typing intervals
      for (const [chatId, timer] of typingIntervalByChatId) {
        clearInterval(timer);
        if (matrixClient) {
          await matrixClient.sendTyping(chatId, false).catch(() => {});
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

      const streamState = streamStates.get(msg.chatId);
      if (streamState) {
        if (streamState.cleanupTimeout) clearTimeout(streamState.cleanupTimeout);
        if (streamState.pendingTimer) clearTimeout(streamState.pendingTimer);
        streamStates.delete(msg.chatId);
        // replyToMessageId cannot be applied to an edit; the initial stream post serves as the reply anchor
        await client.sendEvent(msg.chatId, "m.room.message", {
          "m.new_content": content,
          "m.relates_to": {
            rel_type: "m.replace",
            event_id: streamState.messageId,
          },
          body: msg.text,
        });
        return { messageId: streamState.messageId };
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

    async handleStreamText(
      accumulatedText: string,
      sources: ChannelTurnSource[],
    ): Promise<void> {
      if (!running || !matrixClient) return;

      for (const source of sources) {
        const roomId = source.chatId;
        const existing = streamStates.get(roomId);

        if (!existing) {
          await stopTypingInterval(roomId);
          try {
            const eventId = await matrixClient.sendMessage(roomId, {
              msgtype: "m.text",
              body: accumulatedText,
            });
            streamStates.set(roomId, {
              messageId: String(eventId),
              lastText: accumulatedText,
              lastEditAt: Date.now(),
              pendingTimer: null,
              currentInterval: MATRIX_STREAM_INTERVAL_MS,
              cleanupTimeout: null,
            });
          } catch (error) {
            console.error(
              "[Matrix] Initial stream post failed:",
              error instanceof Error ? error.message : error,
            );
          }
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

    async handleTurnLifecycleEvent(event: ChannelTurnLifecycleEvent): Promise<void> {
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
          scheduleToolBlockUpdate(source.chatId, event.toolName, event.description);
        }
        return;
      }

      // "finished"
      for (const source of event.sources) {
        await stopTypingInterval(source.chatId);

        const streamState = streamStates.get(source.chatId);
        if (streamState) {
          if (streamState.pendingTimer) {
            clearTimeout(streamState.pendingTimer);
            streamState.pendingTimer = null;
          }
          void editStreamMessage(source.chatId, streamState.lastText);
          streamState.cleanupTimeout = setTimeout(() => {
            streamStates.delete(source.chatId);
          }, 10_000);
          streamState.currentInterval = MATRIX_STREAM_INTERVAL_MS;
        }

        const pending = toolBlockOperationByChatId.get(source.chatId);
        if (pending) await pending.catch(() => {});
        toolBlockStateByChatId.delete(source.chatId);
        toolBlockOperationByChatId.delete(source.chatId);
      }
    },

    onMessage: undefined,
  };

  // ── Internal helpers ──────────────────────────────────────────────────────

  async function handleBotCommand(
    roomId: string,
    body: string,
    _event: Record<string, unknown>,
  ): Promise<void> {
    const client = await ensureClient();
    const command = body.split(/\s+/)[0]?.toLowerCase();

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
