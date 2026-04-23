import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InboundChannelMessage } from "../../channels/types";

type FakeBotStartOptions = {
  onStart?: (botInfo: {
    username?: string;
    id: number;
  }) => void | Promise<void>;
  allowed_updates?: string[];
};

type FakeHandler = (ctx: unknown) => unknown | Promise<unknown>;

let channelRoot = join(tmpdir(), "letta-telegram-test-root");

class FakeInputFile {
  readonly file: string;
  readonly filename?: string;

  constructor(file: string, filename?: string) {
    this.file = file;
    this.filename = filename;
  }
}

class FakeBot {
  static instances: FakeBot[] = [];
  static nextStartImpl: (
    options?: FakeBotStartOptions,
    botInfo?: { username?: string; id: number },
  ) => Promise<void> = async (options, botInfo) => {
    await options?.onStart?.(
      botInfo ?? {
        username: "test_bot",
        id: 12345,
      },
    );
  };
  static nextGetFileImpl: (fileId: string) => Promise<{ file_path?: string }> =
    async (fileId) => ({
      file_path: `photos/${fileId}.jpg`,
    });

  readonly token: string;
  botInfo = { username: "test_bot", id: 12345 };
  readonly handlers = new Map<string, FakeHandler[]>();
  readonly api = {
    sendMessage: mock(async () => ({ message_id: 999 })),
    setMessageReaction: mock(async () => true),
    sendPhoto: mock(async () => ({ message_id: 1001 })),
    sendDocument: mock(async () => ({ message_id: 1002 })),
    sendVideo: mock(async () => ({ message_id: 1003 })),
    sendAudio: mock(async () => ({ message_id: 1004 })),
    sendVoice: mock(async () => ({ message_id: 1005 })),
    sendAnimation: mock(async () => ({ message_id: 1006 })),
    getFile: mock(async (fileId: string) => FakeBot.nextGetFileImpl(fileId)),
    answerCallbackQuery: mock(async () => true),
    editMessageText: mock(async () => ({ message_id: 999 })),
    sendChatAction: mock(async () => true),
  };
  catchHandler:
    | ((error: {
        ctx?: { update?: { update_id?: number } };
        error: unknown;
      }) => unknown)
    | null = null;

  constructor(token: string) {
    this.token = token;
    FakeBot.instances.push(this);
  }

  on(event: string, handler: FakeHandler): this {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
    return this;
  }

  command(_command: string, _handler: FakeHandler): this {
    return this;
  }

  async init(): Promise<void> {}

  start(options?: FakeBotStartOptions): Promise<void> {
    return FakeBot.nextStartImpl(options, this.botInfo);
  }

  async stop(): Promise<void> {}

  catch(
    handler: (error: {
      ctx?: { update?: { update_id?: number } };
      error: unknown;
    }) => unknown,
  ): void {
    this.catchHandler = handler;
  }

  async emit(event: string, ctx: unknown): Promise<void> {
    const handlers = this.handlers.get(event) ?? [];
    for (const handler of handlers) {
      await handler(ctx);
    }
  }
}

mock.module("../../channels/config", () => ({
  getChannelDir: (channelId: string) => join(channelRoot, channelId),
}));

mock.module("../../channels/telegram/runtime", () => ({
  loadGrammyModule: async () => ({
    Bot: FakeBot,
    InputFile: FakeInputFile,
  }),
}));

const { createTelegramAdapter } = await import(
  "../../channels/telegram/adapter"
);

const telegramAccountDefaults = {
  accountId: "telegram-test-account",
  displayName: "@test_bot",
  binding: {
    agentId: null,
    conversationId: null,
  },
  createdAt: "2026-04-11T00:00:00.000Z",
  updatedAt: "2026-04-11T00:00:00.000Z",
} as const;

const consoleErrorSpy = mock(() => {});
const originalConsoleError = console.error;
const originalFetch = globalThis.fetch;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  channelRoot = mkdtempSync(join(tmpdir(), "letta-telegram-root-"));
  FakeBot.instances.length = 0;
  FakeBot.nextStartImpl = async (options, botInfo) => {
    await options?.onStart?.(
      botInfo ?? {
        username: "test_bot",
        id: 12345,
      },
    );
  };
  FakeBot.nextGetFileImpl = async (fileId) => ({
    file_path: `photos/${fileId}.jpg`,
  });
  consoleErrorSpy.mockClear();
  console.error = consoleErrorSpy as typeof console.error;
  globalThis.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  console.error = originalConsoleError;
  globalThis.fetch = originalFetch;
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }
  rmSync(channelRoot, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

test("telegram adapter logs unhandled grammY errors with update context", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  expect(bot?.catchHandler).not.toBeNull();

  const error = new Error("middleware boom");
  bot?.catchHandler?.({
    ctx: { update: { update_id: 42 } },
    error,
  });

  expect(consoleErrorSpy).toHaveBeenCalledWith(
    "[Telegram] Unhandled bot error for update 42:",
    error,
  );
});

test("telegram adapter start waits until polling is live before resolving", async () => {
  let releaseStart: (() => Promise<void>) | undefined;

  FakeBot.nextStartImpl = async (options, botInfo) => {
    await new Promise<void>((resolve) => {
      releaseStart = async () => {
        await options?.onStart?.(
          botInfo ?? {
            username: "test_bot",
            id: 12345,
          },
        );
        resolve();
      };
    });
  };

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const startPromise = adapter.start();
  expect(adapter.isRunning()).toBe(false);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(releaseStart).toBeDefined();
  const triggerStart = releaseStart;
  if (!triggerStart) {
    throw new Error("Expected start callback to be registered");
  }
  await triggerStart();
  await startPromise;

  expect(adapter.isRunning()).toBe(true);
});

test("telegram adapter logs and clears running state when polling exits unexpectedly", async () => {
  FakeBot.nextStartImpl = async (options, botInfo) => {
    await options?.onStart?.(
      botInfo ?? {
        username: "test_bot",
        id: 12345,
      },
    );
    throw new Error("polling failed");
  };

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(adapter.isRunning()).toBe(false);
  expect(consoleErrorSpy).toHaveBeenCalledWith(
    "[Telegram] Long-polling stopped unexpectedly:",
    expect.objectContaining({ message: "polling failed" }),
  );
});

test("telegram adapter forwards parse mode and reply parameters", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await adapter.sendMessage({
    channel: "telegram",
    chatId: "123",
    text: "<b>hello</b>",
    replyToMessageId: "456",
    parseMode: "HTML",
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  expect(bot?.api.sendMessage).toHaveBeenCalledWith("123", "<b>hello</b>", {
    parse_mode: "HTML",
    reply_parameters: { message_id: 456 },
  });
});

test("telegram adapter uploads outbound media with a caption", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await adapter.sendMessage({
    channel: "telegram",
    chatId: "123",
    text: "<b>see image</b>",
    parseMode: "HTML",
    replyToMessageId: "456",
    mediaPath: "/tmp/screenshot.png",
    fileName: "screenshot.png",
    title: "Screenshot",
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendPhoto).toHaveBeenCalledWith(
    "123",
    expect.any(FakeInputFile),
    {
      caption: "<b>see image</b>",
      parse_mode: "HTML",
      reply_parameters: { message_id: 456 },
      title: "Screenshot",
    },
  );
});

test("telegram adapter can add reactions to messages", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  await adapter.sendMessage({
    channel: "telegram",
    chatId: "123",
    text: "",
    reaction: "👍",
    targetMessageId: "456",
  });

  const bot = FakeBot.instances[0];
  expect(bot?.api.setMessageReaction).toHaveBeenCalledWith("123", 456, [
    { type: "emoji", emoji: "👍" },
  ]);
});

test("telegram adapter forwards plain text messages through onMessage", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  await bot?.emit("message", {
    message: {
      chat: { id: 123 },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "Hello from Telegram",
      date: 1_736_380_800,
      message_id: 77,
    },
  });

  expect(onMessage).toHaveBeenCalledWith({
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "123",
    senderId: "456",
    senderName: "alice",
    text: "Hello from Telegram",
    timestamp: 1_736_380_800_000,
    messageId: "77",
    chatType: "direct",
    attachments: undefined,
    raw: expect.objectContaining({ message_id: 77 }),
  });
});

test("telegram adapter transcribes inbound voice memos when opt-in is enabled", async () => {
  process.env.OPENAI_API_KEY = "sk-test";

  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url.toString();

    if (href.includes("/file/bottest-token/voice/voice1.ogg")) {
      return new Response(Buffer.from("voice-bytes"), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }

    if (href === "https://api.openai.com/v1/audio/transcriptions") {
      return new Response(JSON.stringify({ text: "Transcribed voice memo" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch URL: ${href}`);
  }) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async () => ({
    file_path: "voice/voice1.ogg",
  });

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
    transcribeVoice: true,
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  await bot?.emit("message", {
    message: {
      chat: { id: 123 },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "",
      date: 1_736_380_800,
      message_id: 77,
      voice: {
        file_id: "voice1",
        file_unique_id: "voice-unique-1",
        mime_type: "audio/ogg",
        file_size: 12,
      },
    },
  });

  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      attachments: [
        expect.objectContaining({
          kind: "audio",
          mimeType: "audio/ogg",
          transcription: "Transcribed voice memo",
        }),
      ],
    }),
  );
});

test("telegram adapter skips voice transcription unless opt-in is enabled", async () => {
  process.env.OPENAI_API_KEY = "sk-test";

  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url.toString();

    if (href.includes("/file/bottest-token/voice/voice1.ogg")) {
      return new Response(Buffer.from("voice-bytes"), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }

    if (href === "https://api.openai.com/v1/audio/transcriptions") {
      throw new Error(
        "Whisper should not be called when transcription is disabled",
      );
    }

    throw new Error(`Unexpected fetch URL: ${href}`);
  }) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async () => ({
    file_path: "voice/voice1.ogg",
  });

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  await bot?.emit("message", {
    message: {
      chat: { id: 123 },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "",
      date: 1_736_380_800,
      message_id: 77,
      voice: {
        file_id: "voice1",
        file_unique_id: "voice-unique-1",
        mime_type: "audio/ogg",
        file_size: 12,
      },
    },
  });

  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      attachments: [
        expect.not.objectContaining({
          transcription: expect.any(String),
        }),
      ],
    }),
  );
});

test("telegram adapter forwards reaction updates through onMessage", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  await bot?.emit("message_reaction", {
    messageReaction: {
      chat: { id: 123, type: "private" },
      user: { id: 456, username: "alice", first_name: "Alice" },
      date: 1_736_380_800,
      message_id: 77,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👍" }],
    },
  });

  expect(onMessage).toHaveBeenCalledWith({
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "123",
    senderId: "456",
    senderName: "alice",
    text: "Telegram reaction added: 👍",
    timestamp: 1_736_380_800_000,
    messageId: "77",
    chatType: "direct",
    reaction: {
      action: "added",
      emoji: "👍",
      targetMessageId: "77",
    },
    raw: expect.objectContaining({ message_id: 77 }),
  });
});

test("telegram adapter batches media groups and downloads inbound images", async () => {
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url.toString();
    const fileName = href.endsWith("photo2.jpg") ? "second" : "first";
    const content = Buffer.from(`image-${fileName}`);
    return new Response(content, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async (fileId) => ({
    file_path: fileId === "photo2" ? "photos/photo2.jpg" : "photos/photo1.jpg",
  });

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  try {
    await bot?.emit("message", {
      message: {
        chat: { id: 123 },
        from: { id: 456, username: "alice", first_name: "Alice" },
        caption: "Vacation photos",
        date: 1_736_380_800,
        message_id: 10,
        media_group_id: "album-1",
        photo: [
          { file_id: "photo1", file_unique_id: "unique-1", file_size: 12 },
        ],
      },
    });
    await bot?.emit("message", {
      message: {
        chat: { id: 123 },
        from: { id: 456, username: "alice", first_name: "Alice" },
        date: 1_736_380_801,
        message_id: 11,
        media_group_id: "album-1",
        photo: [
          { file_id: "photo2", file_unique_id: "unique-2", file_size: 13 },
        ],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 220));

    expect(onMessage).toHaveBeenCalledTimes(1);
    const firstCall = onMessage.mock.calls[0] as unknown as
      | [InboundChannelMessage]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected inbound Telegram album to emit a message");
    }

    const [inbound] = firstCall;

    expect(inbound.text).toBe("Vacation photos");
    expect(inbound.attachments).toHaveLength(2);
    expect(
      inbound.attachments?.every((attachment) => attachment.kind === "image"),
    ).toBe(true);

    const localPaths = inbound.attachments
      ?.map((attachment) => attachment.localPath)
      .filter((value): value is string => typeof value === "string");
    expect(localPaths).toHaveLength(2);

    for (const localPath of localPaths ?? []) {
      expect(existsSync(localPath)).toBe(true);
      expect(readFileSync(localPath, "utf-8").startsWith("image-")).toBe(true);
    }
  } finally {
    rmSync(channelRoot, { recursive: true, force: true });
    channelRoot = mkdtempSync(join(tmpdir(), "letta-telegram-root-"));
  }
});

test("handleControlRequestEvent sends inline keyboard for generic_tool_approval", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  const event = {
    requestId: "req-1",
    kind: "generic_tool_approval" as const,
    source: {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "123",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "Bash",
    input: { command: "rm -rf /tmp/foo" },
  };

  expect(adapter.handleControlRequestEvent).toBeDefined();
  if (!adapter.handleControlRequestEvent)
    throw new Error("handleControlRequestEvent not defined");
  await adapter.handleControlRequestEvent(event);

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "123",
    expect.stringContaining("Bash"),
    expect.objectContaining({
      reply_markup: {
        inline_keyboard: [
          [
            expect.objectContaining({ text: "✅ Approve" }),
            expect.objectContaining({ text: "❌ Deny" }),
            expect.objectContaining({ text: "📝 Deny with Reason" }),
          ],
        ],
      },
    }),
  );
});

test("handleControlRequestEvent sends option buttons for ask_user_question with options", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  const event = {
    requestId: "req-2",
    kind: "ask_user_question" as const,
    source: {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "123",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Which environment?",
          options: [{ label: "Staging" }, { label: "Production" }],
        },
      ],
    },
  };

  expect(adapter.handleControlRequestEvent).toBeDefined();
  if (!adapter.handleControlRequestEvent)
    throw new Error("handleControlRequestEvent not defined");
  await adapter.handleControlRequestEvent(event);

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "123",
    expect.stringContaining("Which environment"),
    expect.objectContaining({
      reply_markup: expect.objectContaining({
        inline_keyboard: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ text: "Staging" }),
            expect.objectContaining({ text: "Production" }),
          ]),
          [expect.objectContaining({ text: "✏️ Something else" })],
        ]),
      }),
    }),
  );
});

test("handleControlRequestEvent sends plain text for ask_user_question without options", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  const event = {
    requestId: "req-3",
    kind: "ask_user_question" as const,
    source: {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "123",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "AskUserQuestion",
    input: {
      questions: [{ question: "What is your name?" }],
    },
  };

  expect(adapter.handleControlRequestEvent).toBeDefined();
  if (!adapter.handleControlRequestEvent)
    throw new Error("handleControlRequestEvent not defined");
  await adapter.handleControlRequestEvent(event);

  const bot = FakeBot.instances[0];
  expect(bot?.api.sendMessage).toHaveBeenCalledWith(
    "123",
    expect.stringContaining("What is your name"),
    expect.not.objectContaining({ reply_markup: expect.anything() }),
  );
});

test("callback_query approve synthesizes approve text and edits the button message", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  // Register the button message by sending an approval prompt first
  expect(adapter.handleControlRequestEvent).toBeDefined();
  if (!adapter.handleControlRequestEvent)
    throw new Error("handleControlRequestEvent not defined");
  await adapter.handleControlRequestEvent({
    requestId: "req-approve",
    kind: "generic_tool_approval" as const,
    source: {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "500",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "Bash",
    input: { command: "echo hi" },
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  if (!bot) throw new Error("bot not found");
  bot.api.sendMessage.mockClear();

  await bot.emit("callback_query", {
    callbackQuery: {
      id: "cq-1",
      data: JSON.stringify({ k: "0", a: "approve" }),
      from: { id: 456, username: "alice" },
      message: { chat: { id: 500 }, message_id: 999 },
    },
  });

  expect(bot.api.answerCallbackQuery).toHaveBeenCalledWith("cq-1");
  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "telegram",
      chatId: "500",
      text: "approve",
    }),
  );
  expect(bot.api.editMessageText).toHaveBeenCalledWith(
    "500",
    999,
    "✅ Approved",
  );
});

test("callback_query deny synthesizes deny text and edits the button message", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  expect(adapter.handleControlRequestEvent).toBeDefined();
  if (!adapter.handleControlRequestEvent)
    throw new Error("handleControlRequestEvent not defined");
  await adapter.handleControlRequestEvent({
    requestId: "req-deny",
    kind: "generic_tool_approval" as const,
    source: {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "500",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "Bash",
    input: { command: "echo hi" },
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  if (!bot) throw new Error("bot not found");
  bot.api.sendMessage.mockClear();

  await bot.emit("callback_query", {
    callbackQuery: {
      id: "cq-2",
      data: JSON.stringify({ k: "0", a: "deny" }),
      from: { id: 456, username: "alice" },
      message: { chat: { id: 500 }, message_id: 999 },
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: "deny" }),
  );
  expect(bot.api.editMessageText).toHaveBeenCalledWith("500", 999, "❌ Denied");
});

test("callback_query option synthesizes the option label and edits the button message", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  expect(adapter.handleControlRequestEvent).toBeDefined();
  if (!adapter.handleControlRequestEvent)
    throw new Error("handleControlRequestEvent not defined");
  await adapter.handleControlRequestEvent({
    requestId: "req-option",
    kind: "ask_user_question" as const,
    source: {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "500",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Environment?",
          options: [{ label: "Staging" }, { label: "Production" }],
        },
      ],
    },
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  if (!bot) throw new Error("bot not found");
  bot.api.sendMessage.mockClear();

  await bot.emit("callback_query", {
    callbackQuery: {
      id: "cq-3",
      data: JSON.stringify({ k: "0", a: "option", i: 0 }),
      from: { id: 456, username: "alice" },
      message: { chat: { id: 500 }, message_id: 999 },
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: "Staging" }),
  );
  expect(bot.api.editMessageText).toHaveBeenCalledWith(
    "500",
    999,
    "Selected: Staging",
  );
});

test("callback_query deny_reason sets awaitingFeedback and sends a prompt", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  expect(adapter.handleControlRequestEvent).toBeDefined();
  if (!adapter.handleControlRequestEvent)
    throw new Error("handleControlRequestEvent not defined");
  await adapter.handleControlRequestEvent({
    requestId: "req-dr",
    kind: "generic_tool_approval" as const,
    source: {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "500",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "Bash",
    input: { command: "echo hi" },
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  if (!bot) throw new Error("bot not found");
  bot.api.sendMessage.mockClear();

  await bot.emit("callback_query", {
    callbackQuery: {
      id: "cq-dr",
      data: JSON.stringify({ k: "0", a: "deny_reason" }),
      from: { id: 456, username: "alice" },
      message: { chat: { id: 500 }, message_id: 999 },
    },
  });

  expect(onMessage).not.toHaveBeenCalled();
  expect(bot.api.sendMessage).toHaveBeenCalledWith(
    "500",
    "Please type your reason for denying.",
    {},
  );
});

test("text message in awaitingFeedback chat submits denial reason via onMessage", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  expect(adapter.handleControlRequestEvent).toBeDefined();
  if (!adapter.handleControlRequestEvent)
    throw new Error("handleControlRequestEvent not defined");
  await adapter.handleControlRequestEvent({
    requestId: "req-dr2",
    kind: "generic_tool_approval" as const,
    source: {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "500",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "Bash",
    input: { command: "echo hi" },
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  if (!bot) throw new Error("bot not found");

  // Tap deny_reason to enter awaitingFeedback state
  await bot.emit("callback_query", {
    callbackQuery: {
      id: "cq-dr2",
      data: JSON.stringify({ k: "0", a: "deny_reason" }),
      from: { id: 456, username: "alice" },
      message: { chat: { id: 500 }, message_id: 999 },
    },
  });

  onMessage.mockClear();
  bot.api.sendMessage.mockClear();

  // User types their reason
  await bot.emit("message", {
    message: {
      chat: { id: 500 },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "Too dangerous",
      date: 1_736_380_800,
      message_id: 1000,
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      chatId: "500",
      text: "Too dangerous",
    }),
  );
  expect(bot.api.editMessageText).toHaveBeenCalledWith(
    "500",
    999,
    "❌ Denied: Too dangerous",
  );
});

test("empty message while awaitingFeedback sends error reply and keeps state open", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  expect(adapter.handleControlRequestEvent).toBeDefined();
  if (!adapter.handleControlRequestEvent)
    throw new Error("handleControlRequestEvent not defined");
  await adapter.handleControlRequestEvent({
    requestId: "req-empty",
    kind: "generic_tool_approval" as const,
    source: {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "500",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "Bash",
    input: {},
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  if (!bot) throw new Error("bot not found");

  await bot.emit("callback_query", {
    callbackQuery: {
      id: "cq-empty",
      data: JSON.stringify({ k: "0", a: "deny_reason" }),
      from: { id: 456, username: "alice" },
      message: { chat: { id: 500 }, message_id: 999 },
    },
  });

  onMessage.mockClear();
  bot.api.sendMessage.mockClear();

  // Send empty message
  await bot.emit("message", {
    message: {
      chat: { id: 500 },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "   ",
      date: 1_736_380_800,
      message_id: 1001,
    },
  });

  expect(onMessage).not.toHaveBeenCalled();
  expect(bot.api.sendMessage).toHaveBeenCalledWith(
    "500",
    "Please type a non-empty reply.",
    {},
  );

  // State is still open — next real message should still be intercepted
  bot.api.sendMessage.mockClear();
  await bot.emit("message", {
    message: {
      chat: { id: 500 },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "Actually too risky",
      date: 1_736_380_801,
      message_id: 1002,
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: "Actually too risky" }),
  );
});

test("callback_query edit failure falls back to sending text confirmation", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  expect(adapter.handleControlRequestEvent).toBeDefined();
  if (!adapter.handleControlRequestEvent)
    throw new Error("handleControlRequestEvent not defined");
  await adapter.handleControlRequestEvent({
    requestId: "req-edit-fail",
    kind: "generic_tool_approval" as const,
    source: {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "500",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "Bash",
    input: {},
  });

  const bot = FakeBot.instances[0];
  expect(bot).toBeDefined();
  if (!bot) throw new Error("bot not found");
  bot.api.editMessageText.mockImplementation(async () => {
    throw new Error("message too old");
  });
  bot.api.sendMessage.mockClear();

  await bot.emit("callback_query", {
    callbackQuery: {
      id: "cq-ef",
      data: JSON.stringify({ k: "0", a: "approve" }),
      from: { id: 456, username: "alice" },
      message: { chat: { id: 500 }, message_id: 999 },
    },
  });

  expect(bot.api.sendMessage).toHaveBeenCalledWith("500", "✅ Approved", {});
});

// ── Lifecycle event tests ─────────────────────────────────────────────────────

const LIFECYCLE_ACCOUNT = {
  ...telegramAccountDefaults,
  channel: "telegram" as const,
  enabled: true,
  token: "test-token",
  dmPolicy: "pairing" as const,
  allowedUsers: [],
};

const LIFECYCLE_SOURCE = {
  channel: "telegram" as const,
  accountId: "telegram-test-account",
  chatId: "chat-42",
  agentId: "agent-1",
  conversationId: "conv-1",
};

test("typing indicator: sendChatAction called on queued event", async () => {
  const adapter = createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "queued",
    source: LIFECYCLE_SOURCE,
  });

  expect(bot.api.sendChatAction).toHaveBeenCalledWith("chat-42", "typing");
  await adapter.stop();
});

test("typing indicator: idempotent — second queued for same chat does not double-start", async () => {
  const adapter = createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({ type: "queued", source: LIFECYCLE_SOURCE });
  const callsAfterFirst = bot.api.sendChatAction.mock.calls.length;
  await adapter.handleTurnLifecycleEvent!({ type: "queued", source: LIFECYCLE_SOURCE });

  expect(bot.api.sendChatAction.mock.calls.length).toBe(callsAfterFirst);
  await adapter.stop();
});

test("typing indicator: processing event starts interval for new chats", async () => {
  const adapter = createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;
  const newSource = { ...LIFECYCLE_SOURCE, chatId: "chat-99" };

  await adapter.handleTurnLifecycleEvent!({
    type: "processing",
    batchId: "batch-1",
    sources: [newSource],
  });

  expect(bot.api.sendChatAction).toHaveBeenCalledWith("chat-99", "typing");
  await adapter.stop();
});

test("tool block: first tool_call sends a new message", async () => {
  const adapter = createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [LIFECYCLE_SOURCE],
  });

  // Wait for async tool block operation to complete
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  const [chatId, text] = bot.api.sendMessage.mock.calls[0]!;
  expect(chatId).toBe("chat-42");
  expect(text).toBe("🔧 Tools used:\n• read_file");
  await adapter.stop();
});

test("tool block: second tool_call edits the existing message", async () => {
  const adapter = createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [LIFECYCLE_SOURCE],
  });
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [LIFECYCLE_SOURCE],
  });

  // Wait for async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(bot.api.sendMessage).toHaveBeenCalledTimes(1); // no second send
  expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
  const [chatId, _msgId, text] = bot.api.editMessageText.mock.calls[0]!;
  expect(chatId).toBe("chat-42");
  expect(text).toBe("🔧 Tools used:\n• read_file ×2");
  await adapter.stop();
});

test("tool block: tool with description grouped correctly", async () => {
  const adapter = createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    description: "Run tests",
    sources: [LIFECYCLE_SOURCE],
  });
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    description: "Run tests",
    sources: [LIFECYCLE_SOURCE],
  });

  // Wait for async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 10));

  const [, _msgId, text] = bot.api.editMessageText.mock.calls[0]!;
  expect(text).toBe("🔧 Tools used:\n• bash — Run tests ×2");
  await adapter.stop();
});

test("tool block: exceeding 3800 chars sends new message", async () => {
  const adapter = createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  // First tool call creates the block
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    sources: [LIFECYCLE_SOURCE],
  });

  // Push 100 distinct descriptions to exceed 3800 chars
  for (let i = 0; i < 100; i++) {
    await adapter.handleTurnLifecycleEvent!({
      type: "tool_call",
      batchId: "batch-1",
      toolName: "bash",
      description: `A very long description that makes things large number ${i}`,
      sources: [LIFECYCLE_SOURCE],
    });
  }

  // Wait for async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 200));

  // sendMessage should have been called more than once (overflow triggered)
  expect(bot.api.sendMessage.mock.calls.length).toBeGreaterThan(1);
  await adapter.stop();
});

test("tool block: cleared on finished (state does not persist across turns)", async () => {
  const adapter = createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [LIFECYCLE_SOURCE],
  });

  // Wait for async operation to complete
  await new Promise((resolve) => setTimeout(resolve, 10));

  const sendCallsBefore = bot.api.sendMessage.mock.calls.length;

  await adapter.handleTurnLifecycleEvent!({
    type: "finished",
    batchId: "batch-1",
    sources: [LIFECYCLE_SOURCE],
    outcome: "completed",
  });

  // New turn — tool_call should create a fresh message, not edit
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-2",
    toolName: "glob",
    sources: [LIFECYCLE_SOURCE],
  });

  // Wait for async operation to complete
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(bot.api.sendMessage.mock.calls.length).toBe(sendCallsBefore + 1);
  expect(bot.api.editMessageText.mock.calls.length).toBe(0);
  await adapter.stop();
});
