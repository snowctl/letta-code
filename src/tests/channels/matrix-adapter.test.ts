// src/tests/channels/matrix-adapter.test.ts
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundChannelMessage } from "../../channels/types";

// ── FakeMatrixClient ──────────────────────────────────────────────────────────

type EventHandler = (
  roomId: string,
  event: Record<string, unknown>,
) => Promise<void> | void;
type InviteHandler = (
  roomId: string,
  event: Record<string, unknown>,
) => Promise<void> | void;

class FakeMatrixClient {
  static instances: FakeMatrixClient[] = [];

  readonly homeserverUrl: string;
  readonly accessToken: string;

  private handlers = new Map<string, EventHandler[]>();
  private inviteHandlers: InviteHandler[] = [];
  private _started = false;

  sendMessage = mock(
    async (_roomId: string, _content: unknown) => "$fake-event-id",
  );
  setTyping = mock(
    async (_roomId: string, _isTyping: boolean, _timeout?: number) => {},
  );
  sendEvent = mock(
    async (_roomId: string, _type: string, _content: unknown) =>
      "$fake-reaction-id",
  );
  redactEvent = mock(
    async (_roomId: string, _eventId: string) => "$fake-redaction-id",
  );
  joinRoom = mock(async (roomId: string) => roomId);
  getUserProfile = mock(async (_userId: string) => ({
    displayname: "Test User",
  }));
  getJoinedRoomMembers = mock(
    async (_roomId: string): Promise<string[]> => [
      "@bot:matrix.org",
      "@user:matrix.org",
    ],
  );
  uploadContent = mock(
    async (_data: Buffer, _contentType: string, _filename: string) =>
      "mxc://matrix.org/abc123",
  );
  mxcToHttp = mock(
    (_mxc: string) =>
      "https://matrix.org/_matrix/media/v3/download/matrix.org/abc123",
  );
  start = mock(async () => {
    this._started = true;
  });
  stop = mock(async () => {
    this._started = false;
  });
  dms = { isDm: (_roomId: string) => false };
  cryptoProviderArg: unknown = undefined;

  constructor(
    homeserverUrl: string,
    accessToken: string,
    _storageProvider?: unknown,
    cryptoProvider?: unknown,
  ) {
    this.homeserverUrl = homeserverUrl;
    this.accessToken = accessToken;
    this.cryptoProviderArg = cryptoProvider;
    FakeMatrixClient.instances.push(this);
  }

  on(event: string, handler: EventHandler): this {
    if (event === "room.invite") {
      this.inviteHandlers.push(handler as InviteHandler);
    } else {
      const existing = this.handlers.get(event) ?? [];
      existing.push(handler);
      this.handlers.set(event, existing);
    }
    return this;
  }

  async emit(
    event: string,
    roomId: string,
    eventObj: Record<string, unknown>,
  ): Promise<void> {
    if (event === "room.invite") {
      for (const h of this.inviteHandlers) await h(roomId, eventObj);
      return;
    }
    for (const h of this.handlers.get(event) ?? []) {
      await h(roomId, eventObj);
    }
  }
}

class FakeSimpleFsStorageProvider {
  constructor(_path: string) {}
}

class FakeRustSdkCryptoStorageProvider {
  constructor(_path: string, _type: unknown) {}
}

// ── Test setup ─────────────────────────────────────────────────────────────────

let channelRoot = join(tmpdir(), "letta-matrix-test");

beforeEach(() => {
  FakeMatrixClient.instances = [];
  channelRoot = mkdtempSync(join(tmpdir(), "letta-matrix-test-"));

  mock.module("../../channels/matrix/runtime", () => ({
    loadMatrixBotSdkModule: async () => ({
      MatrixClient: FakeMatrixClient,
      SimpleFsStorageProvider: FakeSimpleFsStorageProvider,
      RustSdkCryptoStorageProvider: FakeRustSdkCryptoStorageProvider,
      RustSdkCryptoStoreType: { Sled: "sled" },
    }),
    loadMatrixCryptoModule: async () => ({ StoreType: { Sqlite: 0 } }),
    ensureMatrixRuntimeInstalled: async () => true,
    ensureMatrixCryptoUpToDate: async () => false,
  }));

  // Include all config.ts exports so transitive imports (accounts.ts etc.)
  // don't fail with "export not found" when this mock leaks across test files.
  mock.module("../../channels/config", () => ({
    getChannelsRoot: () => channelRoot,
    getChannelDir: (channelId: string) => join(channelRoot, channelId),
    getChannelConfigPath: (channelId: string) =>
      join(channelRoot, channelId, "config.yaml"),
    getChannelAccountsPath: (channelId: string) =>
      join(channelRoot, channelId, "accounts.json"),
    getChannelRoutingPath: (channelId: string) =>
      join(channelRoot, channelId, "routing.json"),
    getChannelPairingPath: (channelId: string) =>
      join(channelRoot, channelId, "pairing.json"),
    getChannelTargetsPath: (channelId: string) =>
      join(channelRoot, channelId, "targets.json"),
    getPendingChannelControlRequestsPath: () =>
      join(channelRoot, "pending-control-requests.json"),
    readChannelConfig: () => null,
  }));
});

afterEach(() => {
  mock.restore();
  rmSync(channelRoot, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_ACCOUNT = {
  channel: "matrix" as const,
  accountId: "acc1",
  homeserverUrl: "https://matrix.example.com",
  accessToken: "syt_test_token",
  userId: "@letta-bot:example.com",
  dmPolicy: "open" as const,
  allowedUsers: [],
  e2ee: false,
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function makeAdapter() {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  return createMatrixAdapter(TEST_ACCOUNT);
}

function getFakeClient(): FakeMatrixClient {
  const client = FakeMatrixClient.instances[0];
  if (!client) throw new Error("No FakeMatrixClient created");
  return client;
}

// ── messageActions tests ───────────────────────────────────────────────────────

test("matrixMessageActions.describeMessageTool returns send, react, upload-file", async () => {
  const { matrixMessageActions } = await import(
    "../../channels/matrix/messageActions"
  );
  const desc = matrixMessageActions.describeMessageTool({ accountId: "acc1" });
  expect(desc.actions).toEqual(["send", "react", "upload-file"]);
});

test("matrixMessageActions.handleAction send calls adapter.sendMessage", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$sent-event");

  const { matrixMessageActions } = await import(
    "../../channels/matrix/messageActions"
  );

  const result = await matrixMessageActions.handleAction({
    request: { action: "send", chatId: "!room:example.com", message: "hello" },
    route: {
      accountId: "acc1",
      chatId: "!room:example.com",
      agentId: "a1",
      conversationId: "c1",
      enabled: true,
      createdAt: "",
    },
    adapter,
    formatText: (t: string) => ({ text: t }),
  } as any);

  expect(result).toContain("Message sent");
  expect(client.sendMessage).toHaveBeenCalledTimes(1);
});

test("matrixMessageActions.handleAction react calls adapter.sendMessage with reaction", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  const { matrixMessageActions } = await import(
    "../../channels/matrix/messageActions"
  );

  const result = await matrixMessageActions.handleAction({
    request: {
      action: "react",
      chatId: "!room:example.com",
      emoji: "👍",
      messageId: "$target",
    },
    route: {
      accountId: "acc1",
      chatId: "!room:example.com",
      agentId: "a1",
      conversationId: "c1",
      enabled: true,
      createdAt: "",
    },
    adapter,
    formatText: (t: string) => ({ text: t }),
  } as any);

  expect(result).toContain("Reaction added");
  expect(client.sendEvent).toHaveBeenCalledWith(
    "!room:example.com",
    "m.reaction",
    expect.objectContaining({
      "m.relates_to": expect.objectContaining({ key: "👍" }),
    }),
  );
});

test("matrixMessageActions.handleAction upload-file calls adapter.sendMessage with mediaPath", async () => {
  const adapter = await makeAdapter();
  await adapter.start();

  // Write a temp file so the adapter can read it
  const tmpFile = join(channelRoot, "test.png");
  await Bun.write(tmpFile, Buffer.from([137, 80, 78, 71])); // minimal PNG header bytes

  const { matrixMessageActions } = await import(
    "../../channels/matrix/messageActions"
  );

  const result = await matrixMessageActions.handleAction({
    request: {
      action: "upload-file",
      chatId: "!room:example.com",
      mediaPath: tmpFile,
    },
    route: {
      accountId: "acc1",
      chatId: "!room:example.com",
      agentId: "a1",
      conversationId: "c1",
      enabled: true,
      createdAt: "",
    },
    adapter,
    formatText: (t: string) => ({ text: t }),
  } as any);

  expect(result).toContain("Attachment sent");
});

// ── Lifecycle and outbound tests ──────────────────────────────────────────────

test("adapter starts and creates MatrixClient with correct args", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  expect(FakeMatrixClient.instances).toHaveLength(1);
  const client = getFakeClient();
  expect(client.homeserverUrl).toBe("https://matrix.example.com");
  expect(client.accessToken).toBe("syt_test_token");
  expect(client.start).toHaveBeenCalledTimes(1);
  expect(adapter.isRunning()).toBe(true);
});

test("adapter stop sets isRunning to false", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  await adapter.stop();
  expect(adapter.isRunning()).toBe(false);
});

test("adapter sendMessage text sends m.text event", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$msg-event-id");

  const result = await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room:example.com",
    text: "hello world",
  });

  expect(result.messageId).toBe("$msg-event-id");
  expect(client.sendMessage).toHaveBeenCalledWith(
    "!room:example.com",
    expect.objectContaining({ msgtype: "m.text", body: "hello world" }),
  );
});

test("adapter sendMessage with parseMode HTML sends formatted_body", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$html-event-id");

  await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room:example.com",
    text: "hello world",
    parseMode: "HTML",
  });

  expect(client.sendMessage).toHaveBeenCalledWith(
    "!room:example.com",
    expect.objectContaining({
      msgtype: "m.text",
      body: "hello world",
      format: "org.matrix.custom.html",
      formatted_body: expect.any(String),
    }),
  );
});

test("adapter sendDirectReply sends plain text message", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await adapter.sendDirectReply("!room:example.com", "pairing code: 1234");

  expect(client.sendMessage).toHaveBeenCalledWith(
    "!room:example.com",
    expect.objectContaining({ msgtype: "m.text", body: "pairing code: 1234" }),
  );
});

test("adapter sendDirectReply with replyToMessageId includes m.in_reply_to", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await adapter.sendDirectReply("!room:example.com", "reply text", {
    replyToMessageId: "$orig-event",
  });

  expect(client.sendMessage).toHaveBeenCalledWith(
    "!room:example.com",
    expect.objectContaining({
      "m.relates_to": { "m.in_reply_to": { event_id: "$orig-event" } },
    }),
  );
});

// ── Task 8: Inbound text, invites, bot commands ───────────────────────────────

test("adapter auto-accepts room invites", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.invite", "!newroom:example.com", {
    type: "m.room.member",
    content: { membership: "invite" },
  });

  expect(client.joinRoom).toHaveBeenCalledWith("!newroom:example.com");
});

test("adapter emits inbound text message to onMessage", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg);
  };
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$evt1",
    content: { msgtype: "m.text", body: "hello" },
  });

  expect(received).toHaveLength(1);
  expect(received[0]?.text).toBe("hello");
  expect(received[0]?.senderId).toBe("@user:example.com");
  expect(received[0]?.chatId).toBe("!room:example.com");
});

test("adapter filters out own messages", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg);
  };
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@letta-bot:example.com", // same as userId in TEST_ACCOUNT
    event_id: "$own-msg",
    content: { msgtype: "m.text", body: "I said this" },
  });

  expect(received).toHaveLength(0);
});

test("adapter responds to !start command", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$cmd1",
    content: { msgtype: "m.text", body: "!start" },
  });

  expect(client.sendMessage).toHaveBeenCalledWith(
    "!room:example.com",
    expect.objectContaining({
      body: expect.stringContaining("Letta"),
    }),
  );
  // Verify it's the welcome/pairing reply, not the status reply
  const call = client.sendMessage.mock.calls[0];
  expect((call?.[1] as any)?.body).toContain("pairing code");
});

test("adapter responds to !status command", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$cmd2",
    content: { msgtype: "m.text", body: "!status" },
  });

  expect(client.sendMessage).toHaveBeenCalledWith(
    "!room:example.com",
    expect.objectContaining({
      body: expect.stringContaining("@letta-bot:example.com"),
    }),
  );
  // Verify it's the status reply, not the welcome reply
  const call = client.sendMessage.mock.calls[0];
  expect((call?.[1] as any)?.body).toContain("DM Policy");
});

test("adapter sets chatType=direct for 2-member rooms", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg);
  };
  await adapter.start();
  const client = getFakeClient();
  client.getJoinedRoomMembers.mockResolvedValueOnce([
    "@bot:example.com",
    "@user:example.com",
  ]);

  await client.emit("room.message", "!room:example.com", {
    sender: "@user:example.com",
    event_id: "$evt2",
    content: { msgtype: "m.text", body: "hi" },
  });

  expect(received[0]?.chatType).toBe("direct");
});

// ── Task 9: Inbound and outbound reactions ────────────────────────────────────

test("adapter emits reaction add as InboundChannelMessage", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg);
  };
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.event", "!room:example.com", {
    type: "m.reaction",
    sender: "@user:example.com",
    content: {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$target-event",
        key: "👍",
      },
    },
  });

  expect(received).toHaveLength(1);
  expect(received[0]?.reaction?.action).toBe("added");
  expect(received[0]?.reaction?.emoji).toBe("👍");
  expect(received[0]?.reaction?.targetMessageId).toBe("$target-event");
});

test("adapter sendMessage with reaction sends m.reaction event", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendEvent.mockResolvedValueOnce("$reaction-event");

  const result = await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room:example.com",
    text: "",
    reaction: "👍",
    targetMessageId: "$target-msg",
  });

  expect(result.messageId).toBe("$reaction-event");
  expect(client.sendEvent).toHaveBeenCalledWith(
    "!room:example.com",
    "m.reaction",
    {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$target-msg",
        key: "👍",
      },
    },
  );
});

test("adapter sendMessage with removeReaction redacts event", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.redactEvent.mockResolvedValueOnce("$redaction-event");

  const result = await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room:example.com",
    text: "",
    removeReaction: true,
    targetMessageId: "$reaction-to-remove",
  });

  expect(result.messageId).toBe("$redaction-event");
  expect(client.redactEvent).toHaveBeenCalledWith(
    "!room:example.com",
    "$reaction-to-remove",
  );
});

// ── Task 10: Control requests approve/deny ────────────────────────────────────

test("handleControlRequestEvent sends prompt and pre-reacts for generic_tool_approval", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$prompt-event");
  client.sendEvent.mockResolvedValue("$reaction-event");

  await adapter.handleControlRequestEvent!({
    requestId: "req1",
    kind: "generic_tool_approval",
    source: {
      channel: "matrix",
      accountId: "acc1",
      chatId: "!room:example.com",
      messageId: "$orig",
      agentId: "a1",
      conversationId: "c1",
    },
    toolName: "bash",
    input: { command: "ls" },
  });

  // Prompt sent
  expect(client.sendMessage).toHaveBeenCalledWith(
    "!room:example.com",
    expect.objectContaining({ body: expect.stringContaining("bash") }),
  );
  // Pre-reacted with ✅, ❌, 📝
  const reactionCalls = client.sendEvent.mock.calls.filter(
    (c: unknown[]) => c[1] === "m.reaction",
  );
  const keys = reactionCalls.map(
    (c: unknown[]) => (c[2] as any)["m.relates_to"].key,
  );
  expect(keys).toContain("✅");
  expect(keys).toContain("❌");
  expect(keys).toContain("📝");
});

test("tapping ✅ emits synthetic approve message", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg);
  };
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$prompt-event");
  client.sendEvent.mockResolvedValue("$reaction-event");

  await adapter.handleControlRequestEvent!({
    requestId: "req1",
    kind: "generic_tool_approval",
    source: {
      channel: "matrix",
      accountId: "acc1",
      chatId: "!room:example.com",
      messageId: "$orig",
      agentId: "a1",
      conversationId: "c1",
    },
    toolName: "bash",
    input: {},
  });

  // User taps ✅
  await client.emit("room.event", "!room:example.com", {
    type: "m.reaction",
    sender: "@user:example.com",
    content: {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$prompt-event",
        key: "✅",
      },
    },
  });

  expect(received).toHaveLength(1);
  expect(received[0]?.text).toBe("approve");
  // Pre-reactions redacted — all 3 (✅, ❌, 📝) returned "$reaction-event"
  expect(client.redactEvent).toHaveBeenCalledWith(
    "!room:example.com",
    "$reaction-event",
  );
  expect(client.redactEvent).toHaveBeenCalledTimes(3);
});

test("tapping ❌ emits synthetic deny message", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg);
  };
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$prompt-event");
  client.sendEvent.mockResolvedValue("$reaction-event");

  await adapter.handleControlRequestEvent!({
    requestId: "req2",
    kind: "enter_plan_mode",
    source: {
      channel: "matrix",
      accountId: "acc1",
      chatId: "!room:example.com",
      messageId: "$orig",
      agentId: "a1",
      conversationId: "c1",
    },
    toolName: "EnterPlanMode",
    input: {},
  });

  await client.emit("room.event", "!room:example.com", {
    type: "m.reaction",
    sender: "@user:example.com",
    content: {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$prompt-event",
        key: "❌",
      },
    },
  });

  expect(received[0]?.text).toBe("deny");
  expect(client.redactEvent).toHaveBeenCalledWith(
    "!room:example.com",
    "$reaction-event",
  );
});

test("bot's own reactions to the prompt are ignored (no self-feedback loop)", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg);
  };
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$prompt-event");
  client.sendEvent.mockResolvedValue("$reaction-event");

  await adapter.handleControlRequestEvent!({
    requestId: "req3",
    kind: "generic_tool_approval",
    source: {
      channel: "matrix",
      accountId: "acc1",
      chatId: "!room:example.com",
      messageId: "$orig",
      agentId: "a1",
      conversationId: "c1",
    },
    toolName: "bash",
    input: {},
  });

  // Bot's own pre-reaction echoes back — should be ignored (senderIdStr === userId)
  await client.emit("room.event", "!room:example.com", {
    type: "m.reaction",
    sender: "@letta-bot:example.com",
    content: {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$prompt-event",
        key: "✅",
      },
    },
  });

  expect(received.filter((m) => m.text === "approve")).toHaveLength(0);
});

// ── Task 11: Freeform flow and ask_user_question ──────────────────────────────

test("tapping 📝 sends follow-up prompt and waits for freeform text", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg);
  };
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$prompt-event") // control request prompt
    .mockResolvedValueOnce("$followup-event"); // follow-up "please type"
  client.sendEvent.mockResolvedValue("$reaction-event");

  await adapter.handleControlRequestEvent!({
    requestId: "req-freeform",
    kind: "generic_tool_approval",
    source: {
      channel: "matrix",
      accountId: "acc1",
      chatId: "!room:example.com",
      messageId: "$orig",
      agentId: "a1",
      conversationId: "c1",
    },
    toolName: "bash",
    input: {},
  });

  // Tap 📝
  await client.emit("room.event", "!room:example.com", {
    type: "m.reaction",
    sender: "@user:example.com",
    content: {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$prompt-event",
        key: "📝",
      },
    },
  });

  // Should NOT emit yet — 📝 tap is a control signal, not a message
  expect(received).toHaveLength(0);
  // Follow-up prompt should have been sent
  expect(client.sendMessage).toHaveBeenCalledWith(
    "!room:example.com",
    expect.objectContaining({
      body: expect.stringContaining("type your reason"),
    }),
  );

  // User types their reason
  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$freeform-reply",
    content: { msgtype: "m.text", body: "because it is dangerous" },
  });

  // Now should have emitted with the freeform text
  const freeformMsg = received.find(
    (m) => m.text === "because it is dangerous",
  );
  expect(freeformMsg).toBeDefined();
  // Pre-reactions should be redacted (generic_tool_approval has ✅, ❌, 📝 = 3)
  expect(client.redactEvent).toHaveBeenCalledWith(
    "!room:example.com",
    "$reaction-event",
  );
  expect(client.redactEvent).toHaveBeenCalledTimes(3);
});

test("ask_user_question with options: tapping 1️⃣ emits synthetic text '1'", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg);
  };
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$prompt-event");
  client.sendEvent.mockResolvedValue("$reaction-event");

  await adapter.handleControlRequestEvent!({
    requestId: "req-ask",
    kind: "ask_user_question",
    source: {
      channel: "matrix",
      accountId: "acc1",
      chatId: "!room:example.com",
      messageId: "$orig",
      agentId: "a1",
      conversationId: "c1",
    },
    toolName: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Which env?",
          options: [{ label: "staging" }, { label: "production" }],
        },
      ],
    },
  });

  // Prompt includes emoji labels
  const promptCall = client.sendMessage.mock.calls[0];
  expect((promptCall?.[1] as any)?.body).toContain("1️⃣");

  // Tap 1️⃣
  await client.emit("room.event", "!room:example.com", {
    type: "m.reaction",
    sender: "@user:example.com",
    content: {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$prompt-event",
        key: "1️⃣",
      },
    },
  });

  expect(received[0]?.text).toBe("1");
});

test("ask_user_question with >10 options sends 10 keycap + 📝 = 11 pre-reactions", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$prompt-event");
  client.sendEvent.mockResolvedValue("$reaction-event");

  const manyOptions = Array.from({ length: 12 }, (_, i) => ({
    label: `Option ${i + 1}`,
  }));

  await adapter.handleControlRequestEvent!({
    requestId: "req-many",
    kind: "ask_user_question",
    source: {
      channel: "matrix",
      accountId: "acc1",
      chatId: "!room:example.com",
      messageId: "$orig",
      agentId: "a1",
      conversationId: "c1",
    },
    toolName: "AskUserQuestion",
    input: { questions: [{ question: "Pick one:", options: manyOptions }] },
  });

  // 10 keycap emojis + 📝 = 11 pre-reactions
  const reactionCalls = client.sendEvent.mock.calls.filter(
    (c: unknown[]) => c[1] === "m.reaction",
  );
  expect(reactionCalls).toHaveLength(11);
});

// ── Task 12: E2EE graceful degradation ───────────────────────────────────────

test("adapter starts without E2EE when crypto addon throws", async () => {
  mock.module("../../channels/matrix/runtime", () => ({
    loadMatrixBotSdkModule: async () => ({
      MatrixClient: FakeMatrixClient,
      SimpleFsStorageProvider: FakeSimpleFsStorageProvider,
      RustSdkCryptoStorageProvider: class {
        constructor() {
          throw new Error("Rust addon failed to load");
        }
      },
      RustSdkCryptoStoreType: { Sled: "sled" },
    }),
    loadMatrixCryptoModule: async () => ({ StoreType: { Sqlite: 0 } }),
    ensureMatrixRuntimeInstalled: async () => true,
    ensureMatrixCryptoUpToDate: async () => false,
  }));

  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const e2eeAccount = { ...TEST_ACCOUNT, e2ee: true };
  const adapter = createMatrixAdapter(e2eeAccount);

  // Should not throw even though crypto addon fails
  await adapter.start();
  expect(adapter.isRunning()).toBe(true);
  // Client created, but without a crypto provider (graceful fallback)
  expect(FakeMatrixClient.instances).toHaveLength(1);
  expect(getFakeClient().cryptoProviderArg).toBeUndefined();
});

// ── Lifecycle event tests ─────────────────────────────────────────────────────

const MATRIX_LIFECYCLE_ACCOUNT = {
  channel: "matrix" as const,
  accountId: "matrix-lifecycle-account",
  homeserverUrl: "https://matrix.example.org",
  accessToken: "lifecycle-token",
  userId: "@bot:matrix.example.org",
  enabled: true,
  dmPolicy: "open" as const,
  allowedUsers: [],
  createdAt: "2026-04-23T00:00:00.000Z",
  updatedAt: "2026-04-23T00:00:00.000Z",
  e2ee: false,
};

const MATRIX_LIFECYCLE_SOURCE = {
  channel: "matrix" as const,
  accountId: "matrix-lifecycle-account",
  chatId: "!room-abc:matrix.example.org",
  agentId: "agent-1",
  conversationId: "conv-1",
};

async function makeLifecycleAdapter() {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  return createMatrixAdapter(MATRIX_LIFECYCLE_ACCOUNT);
}

function getLifecycleFakeClient(): FakeMatrixClient {
  // The lifecycle adapter is created after other adapters in setup; get the last instance
  const client = FakeMatrixClient.instances[FakeMatrixClient.instances.length - 1];
  if (!client) throw new Error("No FakeMatrixClient created");
  return client;
}

test("Matrix typing indicator: setTyping(true) called on queued event", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();

  await adapter.handleTurnLifecycleEvent!({
    type: "queued",
    source: MATRIX_LIFECYCLE_SOURCE,
  });

  expect(client.setTyping).toHaveBeenCalledWith(
    MATRIX_LIFECYCLE_SOURCE.chatId,
    true,
    8000,
  );
});

test("Matrix typing indicator: setTyping(false) called on finished event", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();

  await adapter.handleTurnLifecycleEvent!({
    type: "queued",
    source: MATRIX_LIFECYCLE_SOURCE,
  });

  await adapter.handleTurnLifecycleEvent!({
    type: "finished",
    batchId: "batch-1",
    sources: [MATRIX_LIFECYCLE_SOURCE],
    outcome: "completed",
  });

  expect(client.setTyping).toHaveBeenCalledWith(
    MATRIX_LIFECYCLE_SOURCE.chatId,
    false,
  );
});

test("Matrix tool block: first tool_call sends a new message", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValueOnce("$tool-block-1");

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    description: "run ls",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await new Promise((r) => setTimeout(r, 10));

  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [roomId, content] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
  expect(roomId).toBe(MATRIX_LIFECYCLE_SOURCE.chatId);
  expect(content.msgtype).toBe("m.text");
  expect(content.body).toContain("bash");
  // First message has no m.relates_to (it's a new message, not an edit)
  expect(content["m.relates_to"]).toBeUndefined();
});

test("Matrix tool block: second tool_call edits via m.replace", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$tool-block-1")
    .mockResolvedValueOnce("$tool-block-edit-1");

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await new Promise((r) => setTimeout(r, 10));

  expect(client.sendMessage).toHaveBeenCalledTimes(2);

  const secondCall = client.sendMessage.mock.calls[1] as [string, Record<string, unknown>];
  const secondContent = secondCall[1];
  const relatesTo = secondContent["m.relates_to"] as Record<string, unknown> | undefined;
  expect(relatesTo?.rel_type).toBe("m.replace");
  expect(relatesTo?.event_id).toBe("$tool-block-1");

  const newContent = secondContent["m.new_content"] as Record<string, unknown> | undefined;
  expect(newContent?.body).toContain("bash");
  expect(newContent?.body).toContain("read_file");
});

test("Matrix tool block: no size guard — block grows indefinitely", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();

  // First call returns an event ID; subsequent ones return edits
  client.sendMessage.mockResolvedValue("$tool-block-main");

  for (let i = 0; i < 150; i++) {
    await adapter.handleTurnLifecycleEvent!({
      type: "tool_call",
      batchId: "batch-1",
      toolName: `tool_${i}`,
      description: `desc ${i}`,
      sources: [MATRIX_LIFECYCLE_SOURCE],
    });
  }

  await new Promise((r) => setTimeout(r, 200));

  const calls = client.sendMessage.mock.calls as Array<[string, Record<string, unknown>]>;
  // First call has no m.relates_to
  expect(calls[0]![1]["m.relates_to"]).toBeUndefined();
  // All subsequent calls are edits (have m.relates_to)
  for (let i = 1; i < calls.length; i++) {
    const relatesTo = calls[i]![1]["m.relates_to"] as Record<string, unknown> | undefined;
    expect(relatesTo?.rel_type).toBe("m.replace");
  }
  // All 150 events processed — first is create, rest are edits (no new creates like Telegram would do)
  expect(calls).toHaveLength(150);
});

test("Matrix tool block: cleared on finished", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$block-first")
    .mockResolvedValueOnce("$block-second");

  // First tool_call
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Finish the turn — clears tool block state
  await adapter.handleTurnLifecycleEvent!({
    type: "finished",
    batchId: "batch-1",
    sources: [MATRIX_LIFECYCLE_SOURCE],
    outcome: "completed",
  });

  // Second tool_call in a new turn
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-2",
    toolName: "read_file",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Second tool_call's sendMessage should have no m.relates_to (fresh block)
  const secondCreate = client.sendMessage.mock.calls[1] as [string, Record<string, unknown>];
  expect(secondCreate[1]["m.relates_to"]).toBeUndefined();
});

// ── Reasoning display tests ───────────────────────────────────────────────────

test("matrix adapter sends reasoning drawer and combines with answer in single message", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  const source = {
    channel: "matrix" as const,
    accountId: "acc1",
    chatId: "!room1:example.com",
    agentId: "agent1",
    conversationId: "conv1",
  };

  // First reasoning chunk — adapter sends initial "Thinking..." message
  await adapter.handleStreamReasoning!("I need to search for this.", [source]);

  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [, initialContent] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
  const ic = initialContent as Record<string, unknown>;
  expect(ic.formatted_body as string).toContain("<details><summary>Thinking...</summary>");

  // Second chunk (accumulates in buffer)
  await adapter.handleStreamReasoning!(" Found 3 results.", [source]);

  // Answer arrives — should edit the reasoning message (m.replace), not send a new one
  const callsBefore = client.sendMessage.mock.calls.length;
  const result = await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Here are the results.",
    parseMode: "HTML",
  });

  // Exactly one new sendMessage call should have happened (the final m.replace edit)
  expect(client.sendMessage.mock.calls.length).toBe(callsBefore + 1);
  const [, finalContent] = client.sendMessage.mock.calls[callsBefore] as [string, Record<string, unknown>];
  const fc = finalContent as Record<string, unknown>;

  // Must be an m.replace edit targeting the original message
  expect(fc["m.relates_to"]).toMatchObject({
    rel_type: "m.replace",
    event_id: "$fake-event-id",
  });

  const newContent = fc["m.new_content"] as Record<string, unknown>;
  const html = newContent.formatted_body as string;
  expect(html).toContain("<details><summary>Thinking</summary>");
  expect(html).not.toContain("Thinking...");
  expect(html).toContain("<hr>");
  expect(html).toContain("Here are the results.");
  expect(html).toContain("I need to search for this.");

  // Return value should be the original reasoning message ID
  expect(result.messageId).toBe("$fake-event-id");

  await adapter.stop();
});

test("matrix adapter sends message normally when no reasoning was received", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Hello.",
  });

  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [, content] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
  // No m.relates_to means it's a normal new message, not an edit
  expect((content as Record<string, unknown>)["m.relates_to"]).toBeUndefined();

  await adapter.stop();
});

test("matrix adapter skips reasoning drawer when showReasoning is false", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = createMatrixAdapter({ ...TEST_ACCOUNT, showReasoning: false });
  await adapter.start();
  const client = getFakeClient();

  await adapter.handleStreamReasoning!("thinking...", [
    {
      channel: "matrix" as const,
      accountId: "acc1",
      chatId: "!room1:example.com",
      agentId: "agent1",
      conversationId: "conv1",
    },
  ]);

  // No "Thinking..." message sent
  expect(client.sendMessage).not.toHaveBeenCalled();

  // Answer arrives as a normal message (no m.replace)
  await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Hello.",
  });

  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [, content] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
  expect((content as Record<string, unknown>)["m.relates_to"]).toBeUndefined();

  await adapter.stop();
});
