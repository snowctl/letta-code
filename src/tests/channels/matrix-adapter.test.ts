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

  // Default stubs for operator-command deps — tests override per-test as needed
  mock.module("../../agent/client", () => ({
    getClient: async () => ({}),
  }));

  mock.module("../../channels/registry", () => ({
    getChannelRegistry: () => null,
  }));

  mock.module("../../agent/modify", () => ({
    recompileAgentSystemPrompt: async () => "ok",
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

test("Matrix tool block: first tool_call sends thinking placeholder then tool block", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$thinking-1")
    .mockResolvedValueOnce("$tool-block-1");

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    description: "run ls",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await new Promise((r) => setTimeout(r, 10));

  expect(client.sendMessage).toHaveBeenCalledTimes(2);

  // First call: thinking placeholder (no m.relates_to = new message)
  const [room0, content0] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
  expect(room0).toBe(MATRIX_LIFECYCLE_SOURCE.chatId);
  expect((content0 as Record<string, unknown>).formatted_body as string).toContain(
    "<b>Thinking...</b>",
  );
  expect((content0 as Record<string, unknown>)["m.relates_to"]).toBeUndefined();

  // Second call: tool block (no m.relates_to = new message)
  const [room1, content1] = client.sendMessage.mock.calls[1] as [string, Record<string, unknown>];
  expect(room1).toBe(MATRIX_LIFECYCLE_SOURCE.chatId);
  expect((content1 as Record<string, unknown>).body).toContain("bash");
  expect((content1 as Record<string, unknown>)["m.relates_to"]).toBeUndefined();
});

test("Matrix tool block: second tool_call edits tool block via m.replace", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$thinking-1")
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

  // 3 calls: thinking placeholder + tool block create + tool block edit
  expect(client.sendMessage).toHaveBeenCalledTimes(3);

  const thirdCall = client.sendMessage.mock.calls[2] as [string, Record<string, unknown>];
  const thirdContent = thirdCall[1];
  const relatesTo = thirdContent["m.relates_to"] as Record<string, unknown> | undefined;
  expect(relatesTo?.rel_type).toBe("m.replace");
  expect(relatesTo?.event_id).toBe("$tool-block-1");

  const newContent = thirdContent["m.new_content"] as Record<string, unknown> | undefined;
  expect(newContent?.body).toContain("bash");
  expect(newContent?.body).toContain("read_file");
});

test("Matrix tool block: no size guard — block grows indefinitely", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
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
  // calls[0]: thinking placeholder (no m.relates_to)
  expect(calls[0]![1]["m.relates_to"]).toBeUndefined();
  expect((calls[0]![1] as Record<string, unknown>).formatted_body as string).toContain("Thinking...");
  // calls[1]: tool block create (no m.relates_to)
  expect(calls[1]![1]["m.relates_to"]).toBeUndefined();
  // calls[2..150]: tool block edits
  for (let i = 2; i < calls.length; i++) {
    const relatesTo = calls[i]![1]["m.relates_to"] as Record<string, unknown> | undefined;
    expect(relatesTo?.rel_type).toBe("m.replace");
  }
  // 1 thinking placeholder + 1 tool block create + 149 edits = 151
  expect(calls).toHaveLength(151);
});

test("Matrix tool block: cleared on finished, no redaction (thinking stays)", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$thinking-first")
    .mockResolvedValueOnce("$block-first")
    .mockResolvedValueOnce("$thinking-second")
    .mockResolvedValueOnce("$block-second");

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Finish with no response — thinking stays (buffer empty, no final edit, no redact)
  await adapter.handleTurnLifecycleEvent!({
    type: "finished",
    batchId: "batch-1",
    sources: [MATRIX_LIFECYCLE_SOURCE],
    outcome: "completed",
  });

  // NOT redacted — no redactEvent call
  expect(client.redactEvent).not.toHaveBeenCalled();

  // Second tool_call in a new turn
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-2",
    toolName: "read_file",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Second turn's thinking placeholder is a new message (no m.relates_to)
  const secondThinking = client.sendMessage.mock.calls[2] as [string, Record<string, unknown>];
  expect(secondThinking[1]["m.relates_to"]).toBeUndefined();
  expect((secondThinking[1] as Record<string, unknown>).formatted_body as string).toContain("Thinking...");
  const secondTool = client.sendMessage.mock.calls[3] as [string, Record<string, unknown>];
  expect(secondTool[1]["m.relates_to"]).toBeUndefined();
});

test("Matrix tool block: no thinking placeholder when showReasoning is false", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = createMatrixAdapter({
    ...MATRIX_LIFECYCLE_ACCOUNT,
    showReasoning: false,
  });
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValueOnce("$tool-block-1");

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await new Promise((r) => setTimeout(r, 10));

  // Only 1 message (tool block only, no thinking placeholder)
  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [, content] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
  expect((content as Record<string, unknown>).body).toContain("bash");
  expect((content as Record<string, unknown>).formatted_body).toBeUndefined();

  await adapter.stop();
});

// ── Reasoning display tests ───────────────────────────────────────────────────

test("matrix adapter: reasoning + response finalizes thinking in place and sends plain answer", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$thinking-1")   // initial thinking message
    .mockResolvedValueOnce("$thinking-final") // final edit (finalizeReasoningMessage)
    .mockResolvedValueOnce("$answer-1");    // plain answer

  const source = {
    channel: "matrix" as const,
    accountId: "acc1",
    chatId: "!room1:example.com",
    agentId: "agent1",
    conversationId: "conv1",
  };

  await adapter.handleStreamReasoning!("I need to search for this.", [source]);
  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  await adapter.handleStreamReasoning!(" Found 3 results.", [source]);

  const result = await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Here are the results.",
    parseMode: "HTML",
  });

  // Must NOT redact — thinking stays in the room
  expect(client.redactEvent).not.toHaveBeenCalled();

  // 3 sendMessage calls: initial thinking + final edit + plain answer
  expect(client.sendMessage).toHaveBeenCalledTimes(3);

  // Second call: final edit of thinking message (m.replace, summary changes to "Thinking")
  const [, editContent] = client.sendMessage.mock.calls[1] as [string, Record<string, unknown>];
  const ec = editContent as Record<string, unknown>;
  expect(ec["m.relates_to"]).toMatchObject({ rel_type: "m.replace", event_id: "$thinking-1" });
  const newContent = ec["m.new_content"] as Record<string, unknown>;
  const editHtml = newContent.formatted_body as string;
  expect(editHtml).toContain("<b>Thinking</b>");
  expect(editHtml).toContain("<blockquote>");
  expect(editHtml).not.toContain("Thinking...");
  expect(editHtml).toContain("I need to search for this.");
  expect(editHtml).toContain("Found 3 results.");

  // Third call: plain answer (no m.relates_to, no blockquote drawer)
  const [, answerContent] = client.sendMessage.mock.calls[2] as [string, Record<string, unknown>];
  const ac = answerContent as Record<string, unknown>;
  expect(ac["m.relates_to"]).toBeUndefined();
  expect(ac.formatted_body as string).not.toContain("<blockquote>");

  // Return value is the answer's message ID
  expect(result.messageId).toBe("$answer-1");

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
  expect((content as Record<string, unknown>)["m.relates_to"]).toBeUndefined();
  expect(client.redactEvent).not.toHaveBeenCalled();

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

  await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Hello.",
  });

  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [, content] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
  expect((content as Record<string, unknown>)["m.relates_to"]).toBeUndefined();
  expect(client.redactEvent).not.toHaveBeenCalled();

  await adapter.stop();
});

test("matrix adapter: thinking placeholder (no reasoning content) stays, plain answer sent", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = createMatrixAdapter(TEST_ACCOUNT);
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$thinking-placeholder") // from tool call path
    .mockResolvedValueOnce("$tool-block-1")
    .mockResolvedValueOnce("$plain-response");       // plain answer (buffer empty, no final edit)

  const source = {
    channel: "matrix" as const,
    accountId: "acc1",
    chatId: "!room1:example.com",
    agentId: "agent1",
    conversationId: "conv1",
  };

  // Tool call sends thinking placeholder then tool block
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "b1",
    toolName: "bash",
    sources: [source],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Response arrives — buffer is empty, so NO final edit of thinking message
  const result = await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Done.",
  });

  // Thinking placeholder is NOT redacted
  expect(client.redactEvent).not.toHaveBeenCalled();

  // 3 total sendMessage calls: thinking placeholder + tool block + plain answer
  // (no final edit because buffer was empty)
  expect(client.sendMessage).toHaveBeenCalledTimes(3);

  const [, responseContent] = client.sendMessage.mock.calls[2] as [string, Record<string, unknown>];
  expect((responseContent as Record<string, unknown>).body).toBe("Done.");
  expect((responseContent as Record<string, unknown>)["m.relates_to"]).toBeUndefined();
  expect(result.messageId).toBe("$plain-response");

  await adapter.stop();
});

test("matrix adapter: thinking finalized when turn ends without response", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$thinking-1")    // initial thinking message
    .mockResolvedValueOnce("$thinking-final"); // final edit

  const source = {
    channel: "matrix" as const,
    accountId: "acc1",
    chatId: "!room1:example.com",
    agentId: "agent1",
    conversationId: "conv1",
  };

  await adapter.handleStreamReasoning!("Reasoning about this...", [source]);
  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  // Turn ends without response
  await adapter.handleTurnLifecycleEvent!({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "completed",
  });

  // NOT redacted — stays in room
  expect(client.redactEvent).not.toHaveBeenCalled();

  // Final edit sent (summary changes from "Thinking..." to "Thinking")
  expect(client.sendMessage).toHaveBeenCalledTimes(2);
  const [, editContent] = client.sendMessage.mock.calls[1] as [string, Record<string, unknown>];
  const ec = editContent as Record<string, unknown>;
  expect(ec["m.relates_to"]).toMatchObject({ rel_type: "m.replace", event_id: "$thinking-1" });
  const newContent = ec["m.new_content"] as Record<string, unknown>;
  expect((newContent.formatted_body as string)).toContain("<b>Thinking</b>");
  expect((newContent.formatted_body as string)).toContain("<blockquote>");
  expect((newContent.formatted_body as string)).not.toContain("Thinking...");

  await adapter.stop();
});

// ── Operator command tests ────────────────────────────────────────────────────

test("matrix adapter !cancel replies Cancelled. when run is active", async () => {
  mock.module("../../channels/registry", () => ({
    getChannelRegistry: () => ({
      getRoute: () => ({
        agentId: "agent-1",
        conversationId: "conv-1",
      }),
      cancelActiveRun: () => true,
      updateRouteConversation: () => {},
    }),
  }));
  mock.module("../../agent/client", () => ({
    getClient: async () => ({
      agents: { messages: { compact: async () => ({}) } },
      conversations: {
        list: async () => [],
        create: async () => ({ id: "c1", agent_id: "agent-1" }),
        fork: async () => ({ id: "cf", agent_id: "agent-1" }),
        delete: async () => ({}),
        messages: { compact: async () => ({}) },
      },
    }),
  }));

  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$cancel1",
    content: { msgtype: "m.text", body: "!cancel" },
  });

  const call = client.sendMessage.mock.calls.find(
    (c) => (c[1] as Record<string, unknown>).body === "Cancelled.",
  );
  expect(call).toBeDefined();
  expect(call?.[0]).toBe("!room:example.com");
});

test("matrix adapter !cancel replies No active run. when no run", async () => {
  mock.module("../../channels/registry", () => ({
    getChannelRegistry: () => ({
      getRoute: () => ({
        agentId: "agent-1",
        conversationId: "conv-1",
      }),
      cancelActiveRun: () => false,
      updateRouteConversation: () => {},
    }),
  }));
  mock.module("../../agent/client", () => ({
    getClient: async () => ({
      agents: { messages: { compact: async () => ({}) } },
      conversations: {
        list: async () => [],
        create: async () => ({ id: "c1" }),
        fork: async () => ({ id: "cf" }),
        delete: async () => ({}),
        messages: { compact: async () => ({}) },
      },
    }),
  }));

  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$cancel2",
    content: { msgtype: "m.text", body: "!cancel" },
  });

  const call = client.sendMessage.mock.calls.find(
    (c) => (c[1] as Record<string, unknown>).body === "No active run.",
  );
  expect(call).toBeDefined();
});

test("matrix adapter !conv list replies with Conversations: list", async () => {
  mock.module("../../channels/registry", () => ({
    getChannelRegistry: () => ({
      getRoute: () => ({
        agentId: "agent-1",
        conversationId: "default",
      }),
      cancelActiveRun: () => false,
      updateRouteConversation: () => {},
    }),
  }));
  mock.module("../../agent/client", () => ({
    getClient: async () => ({
      agents: { messages: { compact: async () => ({}) } },
      conversations: {
        list: async () => [],
        create: async () => ({ id: "c1" }),
        fork: async () => ({ id: "cf" }),
        delete: async () => ({}),
        messages: { compact: async () => ({}) },
      },
    }),
  }));

  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$conv1",
    content: { msgtype: "m.text", body: "!conv list" },
  });

  const call = client.sendMessage.mock.calls.find((c) =>
    ((c[1] as Record<string, unknown>).body as string)?.startsWith(
      "Conversations:",
    ),
  );
  expect(call).toBeDefined();
  const body = (call?.[1] as Record<string, unknown>).body as string;
  expect(body).toContain("1. default (current)");
});

test("matrix adapter !compact replies Compaction triggered.", async () => {
  mock.module("../../channels/registry", () => ({
    getChannelRegistry: () => ({
      getRoute: () => ({
        agentId: "agent-1",
        conversationId: "default",
      }),
      cancelActiveRun: () => false,
      updateRouteConversation: () => {},
    }),
  }));
  mock.module("../../agent/client", () => ({
    getClient: async () => ({
      agents: { messages: { compact: async () => ({}) } },
      conversations: {
        list: async () => [],
        create: async () => ({ id: "c1" }),
        fork: async () => ({ id: "cf" }),
        delete: async () => ({}),
        messages: { compact: async () => ({}) },
      },
    }),
  }));

  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$compact1",
    content: { msgtype: "m.text", body: "!compact" },
  });

  const call = client.sendMessage.mock.calls.find(
    (c) =>
      (c[1] as Record<string, unknown>).body === "Compaction triggered.",
  );
  expect(call).toBeDefined();
});

test("matrix adapter !recompile replies System prompt recompiled.", async () => {
  mock.module("../../channels/registry", () => ({
    getChannelRegistry: () => ({
      getRoute: () => ({
        agentId: "agent-1",
        conversationId: "default",
      }),
      cancelActiveRun: () => false,
      updateRouteConversation: () => {},
    }),
  }));
  mock.module("../../agent/client", () => ({
    getClient: async () => ({
      agents: {
        messages: { compact: async () => ({}) },
        recompile: async () => "ok",
      },
      conversations: {
        list: async () => [],
        create: async () => ({ id: "c1" }),
        fork: async () => ({ id: "cf" }),
        delete: async () => ({}),
        messages: { compact: async () => ({}) },
      },
    }),
  }));

  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$recompile1",
    content: { msgtype: "m.text", body: "!recompile" },
  });

  const call = client.sendMessage.mock.calls.find(
    (c) =>
      (c[1] as Record<string, unknown>).body === "System prompt recompiled.",
  );
  expect(call).toBeDefined();
  expect(call?.[0]).toBe("!room:example.com");
});

test("matrix adapter !conv new replies New conversation started and calls updateRouteConversation", async () => {
  const updateRouteConversation = mock(() => {});
  mock.module("../../channels/registry", () => ({
    getChannelRegistry: () => ({
      getRoute: () => ({
        agentId: "agent-1",
        conversationId: "default",
      }),
      cancelActiveRun: () => false,
      updateRouteConversation,
    }),
  }));
  mock.module("../../agent/client", () => ({
    getClient: async () => ({
      agents: { messages: { compact: async () => ({}) } },
      conversations: {
        list: async () => [],
        create: async () => ({ id: "new-conv-id", agent_id: "agent-1" }),
        fork: async () => ({ id: "cf", agent_id: "agent-1" }),
        delete: async () => ({}),
        messages: { compact: async () => ({}) },
      },
    }),
  }));

  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$conv-new1",
    content: { msgtype: "m.text", body: "!conv new" },
  });

  const call = client.sendMessage.mock.calls.find((c) =>
    ((c[1] as Record<string, unknown>).body as string)?.startsWith(
      "New conversation started",
    ),
  );
  expect(call).toBeDefined();
  const body = (call?.[1] as Record<string, unknown>).body as string;
  expect(body).toContain("new-conv-id");
  expect(updateRouteConversation).toHaveBeenCalled();
});

test("matrix adapter !conv fork replies Conversation forked when not on default", async () => {
  const updateRouteConversation = mock(() => {});
  mock.module("../../channels/registry", () => ({
    getChannelRegistry: () => ({
      getRoute: () => ({
        agentId: "agent-1",
        conversationId: "conv-existing",
      }),
      cancelActiveRun: () => false,
      updateRouteConversation,
    }),
  }));
  mock.module("../../agent/client", () => ({
    getClient: async () => ({
      agents: { messages: { compact: async () => ({}) } },
      conversations: {
        list: async () => [],
        create: async () => ({ id: "c1", agent_id: "agent-1" }),
        fork: async () => ({ id: "forked-conv-id", agent_id: "agent-1" }),
        delete: async () => ({}),
        messages: { compact: async () => ({}) },
      },
    }),
  }));

  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$conv-fork1",
    content: { msgtype: "m.text", body: "!conv fork" },
  });

  const call = client.sendMessage.mock.calls.find((c) =>
    ((c[1] as Record<string, unknown>).body as string)?.startsWith(
      "Conversation forked",
    ),
  );
  expect(call).toBeDefined();
  const body = (call?.[1] as Record<string, unknown>).body as string;
  expect(body).toContain("forked-conv-id");
  expect(updateRouteConversation).toHaveBeenCalled();
});

test("matrix adapter !conv fork refuses default conversation", async () => {
  mock.module("../../channels/registry", () => ({
    getChannelRegistry: () => ({
      getRoute: () => ({
        agentId: "agent-1",
        conversationId: "default",
      }),
      cancelActiveRun: () => false,
      updateRouteConversation: () => {},
    }),
  }));
  mock.module("../../agent/client", () => ({
    getClient: async () => ({
      agents: { messages: { compact: async () => ({}) } },
      conversations: {
        list: async () => [],
        create: async () => ({ id: "c1" }),
        fork: async () => ({ id: "cf" }),
        delete: async () => ({}),
        messages: { compact: async () => ({}) },
      },
    }),
  }));

  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$conv-fork-default",
    content: { msgtype: "m.text", body: "!conv fork" },
  });

  const call = client.sendMessage.mock.calls.find((c) =>
    ((c[1] as Record<string, unknown>).body as string)?.includes(
      "Cannot fork the default",
    ),
  );
  expect(call).toBeDefined();
});

test("matrix adapter !conv switch 1 always works without cache", async () => {
  const updateRouteConversation = mock(() => {});
  mock.module("../../channels/registry", () => ({
    getChannelRegistry: () => ({
      getRoute: () => ({
        agentId: "agent-1",
        conversationId: "conv-some",
      }),
      cancelActiveRun: () => false,
      updateRouteConversation,
    }),
  }));
  mock.module("../../agent/client", () => ({
    getClient: async () => ({
      agents: { messages: { compact: async () => ({}) } },
      conversations: {
        list: async () => [],
        create: async () => ({ id: "c1" }),
        fork: async () => ({ id: "cf" }),
        delete: async () => ({}),
        messages: { compact: async () => ({}) },
      },
    }),
  }));

  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  // No !conv list first — switch 1 (default) always works
  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$conv-switch-1",
    content: { msgtype: "m.text", body: "!conv switch 1" },
  });

  const call = client.sendMessage.mock.calls.find(
    (c) => (c[1] as Record<string, unknown>).body === "Switched to: default.",
  );
  expect(call).toBeDefined();
  expect(updateRouteConversation).toHaveBeenCalled();
});

test("matrix adapter !conv switch 2 uses cached list", async () => {
  const updateRouteConversation = mock(() => {});
  mock.module("../../channels/registry", () => ({
    getChannelRegistry: () => ({
      getRoute: () => ({
        agentId: "agent-1",
        conversationId: "default",
      }),
      cancelActiveRun: () => false,
      updateRouteConversation,
    }),
  }));
  mock.module("../../agent/client", () => ({
    getClient: async () => ({
      agents: { messages: { compact: async () => ({}) } },
      conversations: {
        list: async () => [
          { id: "named-conv-1", agent_id: "agent-1", summary: "My Conv" } as unknown as Record<string, unknown>,
        ],
        create: async () => ({ id: "c1" }),
        fork: async () => ({ id: "cf" }),
        delete: async () => ({}),
        messages: { compact: async () => ({}) },
      },
    }),
  }));

  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  // Populate cache first via !conv list
  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$conv-list-for-switch",
    content: { msgtype: "m.text", body: "!conv list" },
  });

  // Now switch to position 2 (the named conv)
  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$conv-switch-2",
    content: { msgtype: "m.text", body: "!conv switch 2" },
  });

  const call = client.sendMessage.mock.calls.find(
    (c) =>
      (c[1] as Record<string, unknown>).body === "Switched to: My Conv.",
  );
  expect(call).toBeDefined();
  expect(updateRouteConversation).toHaveBeenCalled();
});

test("matrix adapter !conv delete 2 deletes named conv and replies Deleted.", async () => {
  const deleteMock = mock(async () => ({}));
  mock.module("../../channels/registry", () => ({
    getChannelRegistry: () => ({
      getRoute: () => ({
        agentId: "agent-1",
        conversationId: "default",
      }),
      cancelActiveRun: () => false,
      updateRouteConversation: () => {},
    }),
  }));
  mock.module("../../agent/client", () => ({
    getClient: async () => ({
      agents: { messages: { compact: async () => ({}) } },
      conversations: {
        list: async () => [
          { id: "named-conv-del", agent_id: "agent-1", summary: "To Delete" } as unknown as Record<string, unknown>,
        ],
        create: async () => ({ id: "c1" }),
        fork: async () => ({ id: "cf" }),
        delete: deleteMock,
        messages: { compact: async () => ({}) },
      },
    }),
  }));

  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  // Populate cache first via !conv list
  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$conv-list-for-delete",
    content: { msgtype: "m.text", body: "!conv list" },
  });

  // Delete position 2 (the named conv)
  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$conv-delete-2",
    content: { msgtype: "m.text", body: "!conv delete 2" },
  });

  const call = client.sendMessage.mock.calls.find(
    (c) => (c[1] as Record<string, unknown>).body === "Deleted.",
  );
  expect(call).toBeDefined();
  expect(deleteMock).toHaveBeenCalled();
});

test("matrix adapter stop() clears convListCache", async () => {
  mock.module("../../channels/registry", () => ({
    getChannelRegistry: () => ({
      getRoute: () => ({
        agentId: "agent-1",
        conversationId: "default",
      }),
      cancelActiveRun: () => false,
      updateRouteConversation: () => {},
    }),
  }));
  mock.module("../../agent/client", () => ({
    getClient: async () => ({
      agents: { messages: { compact: async () => ({}) } },
      conversations: {
        list: async () => [
          { id: "conv-cached", agent_id: "agent-1", summary: "Cached" } as unknown as Record<string, unknown>,
        ],
        create: async () => ({ id: "c1" }),
        fork: async () => ({ id: "cf" }),
        delete: async () => ({}),
        messages: { compact: async () => ({}) },
      },
    }),
  }));

  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  // Populate the cache via !conv list
  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$conv-list-cache",
    content: { msgtype: "m.text", body: "!conv list" },
  });

  // Verify cache is populated: switch 2 should work (returns label not "Run conv list first")
  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$conv-switch-before-stop",
    content: { msgtype: "m.text", body: "!conv switch 2" },
  });
  const switchBeforeStop = client.sendMessage.mock.calls.find(
    (c) =>
      (c[1] as Record<string, unknown>).body === "Switched to: Cached.",
  );
  expect(switchBeforeStop).toBeDefined();

  // Stop the adapter — this clears convListCache
  await adapter.stop();

  // Restart so we can emit messages again
  await adapter.start();
  // getFakeClient() returns instances[0] (the first client), but stop+start
  // creates a new FakeMatrixClient at instances[1]. Grab the newest one.
  const client2 =
    FakeMatrixClient.instances[FakeMatrixClient.instances.length - 1]!;

  // After stop+restart, cache is cleared: switch 2 without a prior list should fail
  await client2.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$conv-switch-after-stop",
    content: { msgtype: "m.text", body: "!conv switch 2" },
  });
  const switchAfterStop = client2.sendMessage.mock.calls.find(
    (c) =>
      ((c[1] as Record<string, unknown>).body as string)?.includes(
        "Run conv list first",
      ),
  );
  expect(switchAfterStop).toBeDefined();
});

test("matrix adapter !help replies with all command names", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$help1",
    content: { msgtype: "m.text", body: "!help" },
  });

  const helpCall = client.sendMessage.mock.calls.find(
    (c) =>
      ((c[1] as Record<string, unknown>).body as string)?.includes("!cancel"),
  );
  expect(helpCall).toBeDefined();
  const body = (helpCall![1] as Record<string, unknown>).body as string;
  expect(body).toContain("!compact");
  expect(body).toContain("!conv list");
  expect(body).toContain("!help");
});
