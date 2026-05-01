// src/channels/matrix/adapter.ts
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
import { markdownToMatrixHtml } from "./htmlFormat";
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
import { ChatTurn } from "./turn/ChatTurn";
import { ChatTurnRegistry } from "./turn/ChatTurnRegistry";

/** Test-only shim — previously controlled the tool-progress grace window.
 *  Task 6 moved per-tool timing into ToolBlock (LIVE_GRACE_MS). This export
 *  is kept for backward-compat with tests; it is a deliberate no-op. */
export function __testSetToolProgressGraceMs(_ms: number): void {
  // no-op: grace window is now controlled by ToolBlock.LIVE_GRACE_MS
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

  // Tracks last sent message id per conversation (for ChannelAction edits).
  const lastSentMessageIdByConversationId = new Map<string, string>();

  // Per-chat turn registry — owns all per-turn state.
  let registry: ChatTurnRegistry | null = null;

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

      // Create the per-chat turn registry. The factory closes over `sender`
      // so it always uses the live sender set above.
      registry = new ChatTurnRegistry((chatId) => {
        return new ChatTurn({
          chatId,
          // biome-ignore lint/style/noNonNullAssertion: start() sets both sender and matrixClient before registry is used
          sender: sender!,
          // biome-ignore lint/style/noNonNullAssertion: start() sets both sender and matrixClient before registry is used
          client: matrixClient!,
          account,
          onDispose: (id) => registry?.delete(id),
          setLastSentMessageId: (convId, msgId) =>
            lastSentMessageIdByConversationId.set(convId, msgId),
        });
      });

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
          startTyping: (chatId) => registry?.getOrCreate(chatId).onProcessing(),
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
      // Dispose all active turns (clears typing intervals, stream timers, etc.)
      registry?.disposeAll();
      registry = null;

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
        // biome-ignore lint/style/noNonNullAssertion: ensureClient() above guarantees sender is non-null
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
        // biome-ignore lint/style/noNonNullAssertion: ensureClient() above guarantees sender is non-null
        const eventId = await sender!.sendReaction(
          msg.chatId,
          // biome-ignore lint/style/noNonNullAssertion: msg.reaction implies msg.targetMessageId is set
          msg.targetMessageId!,
          msg.reaction,
        );
        return { messageId: String(eventId) };
      }

      // Reaction remove
      if (msg.removeReaction && msg.targetMessageId) {
        // biome-ignore lint/style/noNonNullAssertion: ensureClient() above guarantees sender is non-null
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

      // Delegate plain-text path to ChatTurn (drains tool block, handles
      // stream-replace, tracks lastResponse for completion footer).
      // biome-ignore lint/style/noNonNullAssertion: ensureClient() above guarantees the adapter is running and registry is set
      return registry!.getOrCreate(msg.chatId).sendOutbound(msg);
    },

    async sendDirectReply(
      chatId: string,
      text: string,
      options?: { replyToMessageId?: string },
    ): Promise<void> {
      await ensureClient();
      const { html, plaintext } = markdownToMatrixHtml(text);
      await sender?.sendNew(chatId, {
        text: plaintext,
        html,
        replyToMessageId: options?.replyToMessageId,
      });
    },

    async handleAutoForward(
      text: string,
      sources: ChannelTurnSource[],
    ): Promise<string | undefined> {
      // Deferred: store text in ChatTurn; the "finished" handler sends it
      // after finalizing the thinking block to maintain timeline order.
      for (const source of sources) {
        registry?.getOrCreate(source.chatId).setPendingResponseText(text);
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
      await controlRequestsApi?.handleControlRequestEvent(event);
    },

    async handleTurnLifecycleEvent(
      event: ChannelTurnLifecycleEvent,
    ): Promise<void> {
      if (!running) return;

      if (event.type === "queued") {
        registry?.getOrCreate(event.source.chatId).onQueued();
        return;
      }

      if (event.type === "processing") {
        for (const source of event.sources) {
          registry?.getOrCreate(source.chatId).onProcessing();
        }
        return;
      }

      if (event.type === "tool_started") {
        // ChannelAction and NotifyUser are outbound channel tools, not user-visible.
        if (
          event.toolName === "ChannelAction" ||
          event.toolName === "NotifyUser"
        )
          return;
        for (const source of event.sources) {
          registry?.getOrCreate(source.chatId).onToolStart({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            timeoutMs: event.timeoutMs,
          });
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
          registry
            ?.get(source.chatId)
            ?.onToolEnd(event.toolCallId, event.durationMs, event.outcome);
        }
        return;
      }

      if (event.type === "tool_call") {
        if (
          event.toolName === "ChannelAction" ||
          event.toolName === "NotifyUser"
        )
          return;
        for (const source of event.sources) {
          registry
            ?.getOrCreate(source.chatId)
            .onToolCallScheduled(event.toolName, event.description);
        }
        return;
      }

      // "finished" — use getOrCreate so a cold error event still sends a
      // fallback message even when no prior turn state exists.
      for (const source of event.sources) {
        await registry?.getOrCreate(source.chatId).finish(event);
      }
    },

    async handleStreamReasoning(
      chunk: string,
      sources: ChannelTurnSource[],
    ): Promise<void> {
      if (!running) return;
      for (const source of sources) {
        await registry?.getOrCreate(source.chatId).onReasoningChunk(chunk);
      }
    },

    async handleStreamText(
      accumulatedText: string,
      sources: ChannelTurnSource[],
    ): Promise<void> {
      if (!running) return;
      for (const source of sources) {
        await registry
          ?.getOrCreate(source.chatId)
          .onStreamText(accumulatedText);
      }
    },

    async handleStreamReset(sources: ChannelTurnSource[]): Promise<void> {
      if (!running) return;
      for (const source of sources) {
        await registry?.get(source.chatId)?.onStreamReset();
      }
    },

    onMessage: undefined,
  };

  return adapter;
}
