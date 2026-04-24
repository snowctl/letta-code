import { describe, expect, test } from "bun:test";
import { createMatrixAdapter } from "../../channels/matrix/adapter";
import { createTelegramAdapter } from "../../channels/telegram/adapter";
import type {
  MatrixChannelAccount,
  TelegramChannelAccount,
} from "../../channels/types";

const createdAt = "2026-01-01T00:00:00.000Z";
const updatedAt = createdAt;

describe("channel assistant text auto-streaming", () => {
  test("Telegram and Matrix do not auto-stream assistant text", () => {
    const telegramAccount: TelegramChannelAccount = {
      channel: "telegram",
      accountId: "telegram-test",
      displayName: "Telegram Test",
      enabled: true,
      token: "token",
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt,
      updatedAt,
      binding: { agentId: null, conversationId: null },
    };

    const matrixAccount: MatrixChannelAccount = {
      channel: "matrix",
      accountId: "matrix-test",
      displayName: "Matrix Test",
      enabled: true,
      homeserverUrl: "https://matrix.example",
      accessToken: "token",
      userId: "@bot:matrix.example",
      e2ee: false,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt,
      updatedAt,
    };

    expect(
      createTelegramAdapter(telegramAccount).handleStreamText,
    ).toBeUndefined();
    expect(
      createTelegramAdapter(telegramAccount).handleStreamReset,
    ).toBeUndefined();
    expect(createMatrixAdapter(matrixAccount).handleStreamText).toBeUndefined();
    expect(
      createMatrixAdapter(matrixAccount).handleStreamReset,
    ).toBeUndefined();
  });
});
