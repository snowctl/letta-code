// src/channels/matrix/inbound.ts
import type { ChannelAdapter, MatrixChannelAccount } from "../types";
import type { MatrixBotSdkClient } from "./client";
import type { PendingReactionRequest } from "./controlRequests";
import { buildFreeformKey } from "./controlRequests";
import type { MatrixSender } from "./matrixSender";
import { collectMatrixMediaCandidate, downloadMatrixAttachment } from "./media";

// ── RoomMembersCache ──────────────────────────────────────────────────────────

const MEMBERS_CACHE_TTL_MS = 5 * 60 * 1000;

export class RoomMembersCache {
  private cache = new Map<string, { members: string[]; expiresAt: number }>();

  async get(client: MatrixBotSdkClient, roomId: string): Promise<string[]> {
    const now = Date.now();
    const hit = this.cache.get(roomId);
    if (hit && hit.expiresAt > now) return hit.members;
    const members = await client.getJoinedRoomMembers(roomId).catch(() => []);
    this.cache.set(roomId, {
      members,
      expiresAt: now + MEMBERS_CACHE_TTL_MS,
    });
    return members;
  }

  invalidate(roomId: string): void {
    this.cache.delete(roomId);
  }

  clear(): void {
    this.cache.clear();
  }
}

// ── room.message handler ──────────────────────────────────────────────────────

export interface RoomMessageHandlerDeps {
  client: MatrixBotSdkClient;
  account: MatrixChannelAccount;
  accountId: string;
  userId: string;
  sender: MatrixSender;
  membersCache: RoomMembersCache;
  pendingReactionRequests: Map<string, PendingReactionRequest>;
  awaitingFreeformByChat: Map<string, string>;
  startTyping: (chatId: string) => void;
  redactControlRequestReactions: (req: PendingReactionRequest) => Promise<void>;
  handleBotCommand: (
    roomId: string,
    body: string,
    event: Record<string, unknown>,
  ) => Promise<void>;
  /** Invoked once the inbound message is fully assembled. May be undefined when adapter has no listener yet. */
  getOnMessage: () => ChannelAdapter["onMessage"];
  transcribeVoice: boolean;
  maxMediaDownloadBytes: number;
}

export function makeRoomMessageHandler(deps: RoomMessageHandlerDeps) {
  const {
    client,
    accountId,
    userId,
    sender,
    membersCache,
    pendingReactionRequests,
    awaitingFreeformByChat,
    startTyping,
    redactControlRequestReactions,
    handleBotCommand,
    transcribeVoice,
    maxMediaDownloadBytes,
  } = deps;

  return async (roomId: unknown, event: unknown): Promise<void> => {
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
        await handleBotCommand(roomIdStr, body, eventObj).catch(async (err) => {
          await sender
            .sendNew(roomIdStr, {
              text: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
            })
            .catch(() => {});
        });
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
    const isMediaMsgtype = ["m.image", "m.video", "m.audio", "m.file"].includes(
      msgtype ?? "",
    );
    const textContent =
      (candidate && body === candidate.filename) ||
      (!candidate && isMediaMsgtype)
        ? ""
        : body;

    if (!textContent && attachments.length === 0) return;

    // Start typing before the member-lookup network call so the indicator
    // appears immediately rather than after the round-trip completes.
    startTyping(roomIdStr);

    const members = await membersCache.get(client, roomIdStr);
    const chatType: "direct" | "channel" =
      members.length === 2 ? "direct" : "channel";

    const msg = {
      channel: "matrix" as const,
      accountId,
      chatId: roomIdStr,
      senderId: senderIdStr,
      text: textContent,
      timestamp: Date.now(),
      messageId: eventObj.event_id as string | undefined,
      chatType,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    await deps.getOnMessage()?.(msg);
  };
}

// ── room.event handler ────────────────────────────────────────────────────────

export interface RoomEventHandlerDeps {
  membersCache: RoomMembersCache;
  handleReactionEvent: (
    roomId: string,
    event: Record<string, unknown>,
  ) => Promise<void>;
  handleRedactionEvent: (
    roomId: string,
    event: Record<string, unknown>,
  ) => Promise<void>;
}

export function makeRoomEventHandler(deps: RoomEventHandlerDeps) {
  const { membersCache, handleReactionEvent, handleRedactionEvent } = deps;

  return async (roomId: unknown, event: unknown): Promise<void> => {
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
      membersCache.invalidate(roomIdStr);
      return;
    }
  };
}
