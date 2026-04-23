// src/channels/matrix/adapter.ts
// Partial implementation — lifecycle and outbound are expanded in Task 7.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  ChannelAdapter,
  InboundChannelMessage,
  MatrixChannelAccount,
  OutboundChannelMessage,
} from "../types";
import { inferMimeTypeFromExtension, kindToMatrixMsgtype } from "./media";
import type { MatrixBotSdkLike } from "./runtime";
import { loadMatrixBotSdkModule } from "./runtime";

// Local shape for the matrix-bot-sdk client methods we use.
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
}

export async function createMatrixAdapter(
  account: MatrixChannelAccount,
): Promise<ChannelAdapter> {
  let sdk: MatrixBotSdkLike | null = null;
  let client: MatrixClientLike | null = null;
  let running = false;

  const adapterId = `matrix:${account.accountId}`;

  async function getOrLoadSdk(): Promise<MatrixBotSdkLike> {
    if (!sdk) {
      sdk = await loadMatrixBotSdkModule();
    }
    return sdk;
  }

  const adapter: ChannelAdapter = {
    id: adapterId,
    channelId: "matrix",
    accountId: account.accountId,
    name: "Matrix",

    async start(): Promise<void> {
      if (running) return;
      const { MatrixClient, SimpleFsStorageProvider } = await getOrLoadSdk();

      // Instantiate without storage path complexity for now.
      client = new (
        MatrixClient as unknown as new (
          url: string,
          token: string,
          storage: unknown,
        ) => MatrixClientLike
      )(
        account.homeserverUrl,
        account.accessToken,
        new (SimpleFsStorageProvider as unknown as new (p: string) => unknown)(
          `/tmp/matrix-${account.accountId}-storage`,
        ),
      );

      await client.start();
      running = true;
    },

    async stop(): Promise<void> {
      if (!running || !client) return;
      await client.stop();
      running = false;
    },

    isRunning(): boolean {
      return running;
    },

    async sendMessage(
      msg: OutboundChannelMessage,
    ): Promise<{ messageId: string }> {
      if (!client) throw new Error("Matrix adapter not started");

      // Reaction handling
      if (msg.targetMessageId && msg.reaction !== undefined) {
        if (msg.removeReaction) {
          // Redact the reaction event — for now we stub a redaction
          const eventId = await client.redactEvent(
            msg.chatId,
            msg.targetMessageId,
          );
          return { messageId: eventId };
        }
        const eventId = await client.sendEvent(msg.chatId, "m.reaction", {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: msg.targetMessageId,
            key: msg.reaction,
          },
        });
        return { messageId: eventId };
      }

      // Media / file upload
      if (msg.mediaPath) {
        const filename = msg.fileName ?? basename(msg.mediaPath);
        const mimeType = inferMimeTypeFromExtension(filename);
        const data = await readFile(msg.mediaPath);
        const mxcUrl = await client.uploadContent(data, mimeType, filename);
        const msgtype = kindToMatrixMsgtype(mimeType);
        const eventId = await client.sendMessage(msg.chatId, {
          msgtype,
          body: filename,
          url: mxcUrl,
        });
        return { messageId: eventId };
      }

      // Plain text
      const eventId = await client.sendMessage(msg.chatId, {
        msgtype: "m.text",
        body: msg.text,
      });
      return { messageId: eventId };
    },

    async sendDirectReply(
      chatId: string,
      text: string,
      _options?: { replyToMessageId?: string },
    ): Promise<void> {
      if (!client) throw new Error("Matrix adapter not started");
      await client.sendMessage(chatId, { msgtype: "m.text", body: text });
    },
  };

  return adapter;
}
