// src/tests/channels/matrix-adapter.test.ts
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createCipheriv } from "node:crypto";
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
  downloadContent = mock(
    async (
      _mxcUrl: string,
    ): Promise<{ data: Buffer; contentType: string }> => ({
      data: Buffer.alloc(0),
      contentType: "application/octet-stream",
    }),
  );
  start = mock(async () => {
    this._started = true;
  });
  stop = mock(async () => {
    this._started = false;
  });
  dms = { isDm: (_roomId: string) => false };
  _started: boolean = false;
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

class FakeSimpleFsStorageProvider {}

class FakeRustSdkCryptoStorageProvider {}

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
      // setRequestFn: no-op in tests — production code installs an undici-
      // backed fetch shim here, but FakeMatrixClient never makes real HTTP
      // calls.
      setRequestFn: () => {},
    }),
    loadMatrixCryptoModule: async () => ({ StoreType: { Sqlite: 0 } }),
    // Stub the undici loader so adapter.ts's getUndiciDispatcher() resolves
    // without touching the channel-runtime install.
    loadUndiciModule: async () => ({
      Agent: class {
        async destroy() {}
      },
      fetch: async () => ({
        status: 200,
        headers: { forEach: () => {} },
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    }),
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
    updateAgentLLMConfig: async () => {},
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

test("matrixMessageActions.describeMessageTool returns send, react, upload-file, edit", async () => {
  const { matrixMessageActions } = await import(
    "../../channels/matrix/messageActions"
  );
  const desc = matrixMessageActions.describeMessageTool({ accountId: "acc1" });
  expect(desc.actions).toEqual(["send", "react", "upload-file", "edit"]);
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

test("matrixMessageActions.handleAction edit sends m.replace with new content", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  const { matrixMessageActions } = await import(
    "../../channels/matrix/messageActions"
  );

  const result = await matrixMessageActions.handleAction({
    request: {
      action: "edit",
      chatId: "!room:example.com",
      messageId: "$original-msg",
      message: "updated body",
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

  expect(result).toContain("Message edited");
  // result contains the replace event's own ID (from sendEvent), not the target.
  expect(result).toContain("$fake-reaction-id");
  // Edit now goes through MatrixSender.edit → sendEvent (not sendMessage)
  expect(client.sendMessage).not.toHaveBeenCalled();
  const editCall = client.sendEvent.mock.calls.find(
    (c) => c[1] === "m.room.message",
  );
  expect(editCall).toBeDefined();
  const callArgs = editCall![2] as Record<string, unknown>;
  expect(callArgs["m.relates_to"]).toEqual({
    rel_type: "m.replace",
    event_id: "$original-msg",
  });
  expect(callArgs["m.new_content"]).toBeDefined();
  const newContent = callArgs["m.new_content"] as Record<string, unknown>;
  expect(newContent.body).toBe("updated body");
  // body gets "* " prefix for fallback clients; formatted_body does NOT have "* " prefix
  expect((callArgs.body as string).startsWith("* ")).toBe(true);
  if (callArgs.formatted_body !== undefined) {
    expect((callArgs.formatted_body as string).startsWith("* ")).toBe(false);
  }
});

test("matrixMessageActions.handleAction edit returns error when messageId missing", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const { matrixMessageActions } = await import(
    "../../channels/matrix/messageActions"
  );
  const result = await matrixMessageActions.handleAction({
    request: {
      action: "edit",
      chatId: "!room:example.com",
      message: "x",
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
  expect(result).toMatch(/edit requires messageId/);
});

test("matrixMessageActions.handleAction edit returns error when message body missing", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const { matrixMessageActions } = await import(
    "../../channels/matrix/messageActions"
  );
  const result = await matrixMessageActions.handleAction({
    request: {
      action: "edit",
      chatId: "!room:example.com",
      messageId: "$x",
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
  expect(result).toMatch(/edit requires message/);
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

  const result = await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room:example.com",
    text: "",
    removeReaction: true,
    targetMessageId: "$reaction-to-remove",
  });

  // The returned messageId is the redaction event's own ID (from redactEvent).
  expect(result.messageId).toBe("$fake-redaction-id");
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

  await adapter.handleControlRequestEvent?.({
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

  await adapter.handleControlRequestEvent?.({
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

  await adapter.handleControlRequestEvent?.({
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

  await adapter.handleControlRequestEvent?.({
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

  await adapter.handleControlRequestEvent?.({
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

  await adapter.handleControlRequestEvent?.({
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

  await adapter.handleControlRequestEvent?.({
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
      setRequestFn: () => {},
    }),
    loadMatrixCryptoModule: async () => ({ StoreType: { Sqlite: 0 } }),
    loadUndiciModule: async () => ({
      Agent: class {
        async destroy() {}
      },
      fetch: async () => ({
        status: 200,
        headers: { forEach: () => {} },
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    }),
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
  const client =
    FakeMatrixClient.instances[FakeMatrixClient.instances.length - 1];
  if (!client) throw new Error("No FakeMatrixClient created");
  return client;
}

test("Matrix typing indicator: setTyping(true) called on queued event", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();

  await adapter.handleTurnLifecycleEvent?.({
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

  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source: MATRIX_LIFECYCLE_SOURCE,
  });

  await adapter.handleTurnLifecycleEvent?.({
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

test("Matrix turn state: finished(completed) edits last response with completion footer", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();

  // processing stamps turn start; sendMessage captures last response event ID
  client.sendMessage.mockResolvedValueOnce("$response-1"); // plain text response

  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await adapter.sendMessage({
    channel: "matrix",
    accountId: MATRIX_LIFECYCLE_SOURCE.accountId,
    chatId: MATRIX_LIFECYCLE_SOURCE.chatId,
    text: "Here are the results.",
  });

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [MATRIX_LIFECYCLE_SOURCE],
    outcome: "completed",
  });

  // One sendMessage call (response); footer edit goes through sendEvent now
  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  // Footer edit is sent via sendEvent (MatrixSender.edit → sendEvent)
  const footerEditCall = client.sendEvent.mock.calls.find(
    (c) =>
      (c[2] as Record<string, unknown>)?.["m.relates_to"] !== undefined &&
      (
        (c[2] as Record<string, unknown>)["m.relates_to"] as Record<
          string,
          unknown
        >
      )?.rel_type === "m.replace",
  );
  expect(footerEditCall).toBeDefined();
  const [footerRoom, , footerContent] = footerEditCall! as [
    string,
    string,
    Record<string, unknown>,
  ];
  expect(footerRoom).toBe(MATRIX_LIFECYCLE_SOURCE.chatId);

  // Must be an m.replace edit on the response event ID
  expect(footerContent["m.relates_to"]).toMatchObject({
    rel_type: "m.replace",
    event_id: "$response-1",
  });

  // formatted_body must contain the green check and "completed in"
  const newContent = footerContent["m.new_content"] as Record<string, unknown>;
  const html = newContent.formatted_body as string;
  expect(html).toContain('data-mx-color="#3fb950"');
  expect(html).toContain("✓");
  expect(html).toContain("completed in");

  // plain body must also contain the footer
  const body = newContent.body as string;
  expect(body).toContain("✓ completed in");
});

test("Matrix tool block: first tool_call sends tool block (no thinking placeholder without reasoning)", async () => {
  // After the empty-thinking-block bug fix, ThinkingBlock is only created on
  // the first onReasoningChunk. A tool_call without prior reasoning produces
  // only the tool block — no separate thinking placeholder.
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValueOnce("$tool-block-1");

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    description: "run ls",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await new Promise((r) => setTimeout(r, 10));

  // Only 1 sendMessage (tool block) — no thinking placeholder.
  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  const [room0, content0] = client.sendMessage.mock.calls[0] as [
    string,
    Record<string, unknown>,
  ];
  expect(room0).toBe(MATRIX_LIFECYCLE_SOURCE.chatId);
  expect((content0 as Record<string, unknown>).body).toContain("bash");
  expect((content0 as Record<string, unknown>)["m.relates_to"]).toBeUndefined();
});

test("Matrix tool block: second tool_call edits tool block via m.replace", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  // No thinking placeholder — only tool block (no prior reasoning).
  client.sendMessage.mockResolvedValueOnce("$tool-block-1");

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await new Promise((r) => setTimeout(r, 10));

  // 1 sendMessage call: tool block create (no thinking placeholder)
  // Tool block edit goes through sendEvent (MatrixSender.edit)
  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  // Tool block edit is the first m.room.message sendEvent with m.replace
  const editCall = client.sendEvent.mock.calls.find(
    (c) =>
      c[1] === "m.room.message" &&
      (
        (c[2] as Record<string, unknown>)["m.relates_to"] as Record<
          string,
          unknown
        >
      )?.rel_type === "m.replace",
  );
  expect(editCall).toBeDefined();
  const editContent = editCall![2] as Record<string, unknown>;
  const relatesTo = editContent["m.relates_to"] as Record<string, unknown>;
  expect(relatesTo.rel_type).toBe("m.replace");
  expect(relatesTo.event_id).toBe("$tool-block-1");

  const newContent = editContent["m.new_content"] as Record<string, unknown>;
  expect(newContent.body).toContain("bash");
  expect(newContent.body).toContain("read_file");
});

test("Matrix tool block: no size guard — block grows indefinitely", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValue("$tool-block-main");

  for (let i = 0; i < 150; i++) {
    await adapter.handleTurnLifecycleEvent?.({
      type: "tool_call",
      batchId: "batch-1",
      toolName: `tool_${i}`,
      description: `desc ${i}`,
      sources: [MATRIX_LIFECYCLE_SOURCE],
    });
  }

  await new Promise((r) => setTimeout(r, 200));

  const sendMessageCalls = client.sendMessage.mock.calls as Array<
    [string, Record<string, unknown>]
  >;
  // Only 1 sendMessage: tool block create (no thinking placeholder without reasoning)
  expect(sendMessageCalls[0]?.[1]["m.relates_to"]).toBeUndefined();
  expect((sendMessageCalls[0]?.[1] as Record<string, unknown>).body).toContain(
    "tool_0",
  );
  expect(sendMessageCalls).toHaveLength(1);

  // Tool block edits (149 of them) now go through sendEvent (MatrixSender.edit)
  const editCalls = client.sendEvent.mock.calls.filter(
    (c) =>
      c[1] === "m.room.message" &&
      (
        (c[2] as Record<string, unknown>)["m.relates_to"] as Record<
          string,
          unknown
        >
      )?.rel_type === "m.replace",
  );
  for (const editCall of editCalls) {
    const relatesTo = (editCall[2] as Record<string, unknown>)[
      "m.relates_to"
    ] as Record<string, unknown>;
    expect(relatesTo.rel_type).toBe("m.replace");
  }
  // 149 tool block edits
  expect(editCalls).toHaveLength(149);
});

test("Matrix tool block: cleared on finished, second turn creates fresh tool block", async () => {
  // After the empty-thinking-block bug fix, no thinking placeholder is sent for
  // tool_call without prior reasoning. Each turn creates only a tool block.
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$block-first")
    .mockResolvedValueOnce("$block-second");

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Finish with no response — no redactEvent call
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [MATRIX_LIFECYCLE_SOURCE],
    outcome: "completed",
  });

  // NOT redacted — no redactEvent call
  expect(client.redactEvent).not.toHaveBeenCalled();

  // Second tool_call in a new turn
  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_call",
    batchId: "batch-2",
    toolName: "read_file",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Second turn's tool block is a new message (no m.relates_to)
  const secondTool = client.sendMessage.mock.calls[1] as [
    string,
    Record<string, unknown>,
  ];
  expect(secondTool[1]["m.relates_to"]).toBeUndefined();
  expect((secondTool[1] as Record<string, unknown>).body).toContain(
    "read_file",
  );
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

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await new Promise((r) => setTimeout(r, 10));

  // Only 1 message (tool block only, no thinking placeholder)
  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [, content] = client.sendMessage.mock.calls[0] as [
    string,
    Record<string, unknown>,
  ];
  expect((content as Record<string, unknown>).body).toContain("bash");
  expect((content as Record<string, unknown>).formatted_body).toBeUndefined();

  await adapter.stop();
});

// ── Reasoning display tests ───────────────────────────────────────────────────

test("matrix adapter: reasoning + response finalizes thinking at finished (not at sendMessage)", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$thinking-1") // initial thinking message
    .mockResolvedValueOnce("$answer-1"); // plain answer (sendMessage)

  const source = {
    channel: "matrix" as const,
    accountId: "acc1",
    chatId: "!room1:example.com",
    agentId: "agent1",
    conversationId: "conv1",
  };

  await adapter.handleStreamReasoning?.("I need to search for this.", [source]);
  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  await adapter.handleStreamReasoning?.(" Found 3 results.", [source]);

  const result = await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Here are the results.",
    parseMode: "HTML",
  });

  // sendMessage only sends the answer — thinking NOT finalized yet
  expect(client.redactEvent).not.toHaveBeenCalled();
  expect(client.sendMessage).toHaveBeenCalledTimes(2);
  expect(result.messageId).toBe("$answer-1");

  // Second call: plain answer (no m.relates_to)
  const [, answerContent] = client.sendMessage.mock.calls[1] as [
    string,
    Record<string, unknown>,
  ];
  expect(
    (answerContent as Record<string, unknown>)["m.relates_to"],
  ).toBeUndefined();

  // Thinking is finalized only when the turn ends
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "completed",
  });

  // 2 sendMessage calls (thinking + answer); finalize and footer go through sendEvent
  expect(client.sendMessage).toHaveBeenCalledTimes(2);

  // Thinking finalization: sendEvent with m.replace on thinking-1
  const thinkingEditCall = client.sendEvent.mock.calls.find(
    (c) =>
      c[1] === "m.room.message" &&
      (
        (c[2] as Record<string, unknown>)["m.relates_to"] as Record<
          string,
          unknown
        >
      )?.event_id === "$thinking-1",
  );
  expect(thinkingEditCall).toBeDefined();
  const ec = thinkingEditCall![2] as Record<string, unknown>;
  expect(ec["m.relates_to"]).toMatchObject({
    rel_type: "m.replace",
    event_id: "$thinking-1",
  });
  const newContent = ec["m.new_content"] as Record<string, unknown>;
  const editHtml = newContent.formatted_body as string;
  expect(editHtml).toContain("<b>Thinking</b>");
  expect(editHtml).toContain("<blockquote>");
  expect(editHtml).not.toContain("Thinking...");
  expect(editHtml).toContain("I need to search for this.");
  expect(editHtml).toContain("Found 3 results.");

  // Completion footer edit: sendEvent with m.replace on answer-1
  const footerEditCall = client.sendEvent.mock.calls.find(
    (c) =>
      c[1] === "m.room.message" &&
      (
        (c[2] as Record<string, unknown>)["m.relates_to"] as Record<
          string,
          unknown
        >
      )?.event_id === "$answer-1",
  );
  expect(footerEditCall).toBeDefined();
  const fe = footerEditCall![2] as Record<string, unknown>;
  expect(fe["m.relates_to"]).toMatchObject({
    rel_type: "m.replace",
    event_id: "$answer-1",
  });

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
  const [, content] = client.sendMessage.mock.calls[0] as [
    string,
    Record<string, unknown>,
  ];
  expect((content as Record<string, unknown>)["m.relates_to"]).toBeUndefined();
  expect(client.redactEvent).not.toHaveBeenCalled();

  await adapter.stop();
});

test("matrix adapter skips reasoning drawer when showReasoning is false", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = createMatrixAdapter({
    ...TEST_ACCOUNT,
    showReasoning: false,
  });
  await adapter.start();
  const client = getFakeClient();

  await adapter.handleStreamReasoning?.("thinking...", [
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
  const [, content] = client.sendMessage.mock.calls[0] as [
    string,
    Record<string, unknown>,
  ];
  expect((content as Record<string, unknown>)["m.relates_to"]).toBeUndefined();
  expect(client.redactEvent).not.toHaveBeenCalled();

  await adapter.stop();
});

test("matrix adapter: tool_call without reasoning then plain answer (no thinking placeholder)", async () => {
  // After the empty-thinking-block bug fix, tool_call without prior reasoning
  // sends only the tool block — no thinking placeholder is created.
  // The plain answer arrives after as a separate message.
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = createMatrixAdapter(TEST_ACCOUNT);
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$tool-block-1")
    .mockResolvedValueOnce("$plain-response"); // plain answer

  const source = {
    channel: "matrix" as const,
    accountId: "acc1",
    chatId: "!room1:example.com",
    agentId: "agent1",
    conversationId: "conv1",
  };

  // Tool call sends only tool block (no thinking placeholder)
  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_call",
    batchId: "b1",
    toolName: "bash",
    sources: [source],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Response arrives
  const result = await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Done.",
  });

  // No redact
  expect(client.redactEvent).not.toHaveBeenCalled();

  // 2 total sendMessage calls: tool block + plain answer (no thinking placeholder)
  expect(client.sendMessage).toHaveBeenCalledTimes(2);

  const [, responseContent] = client.sendMessage.mock.calls[1] as [
    string,
    Record<string, unknown>,
  ];
  expect((responseContent as Record<string, unknown>).body).toBe("Done.");
  expect(
    (responseContent as Record<string, unknown>)["m.relates_to"],
  ).toBeUndefined();
  expect(result.messageId).toBe("$plain-response");

  await adapter.stop();
});

test("matrix adapter: thinking finalized when turn ends without response", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$thinking-1"); // initial thinking message

  const source = {
    channel: "matrix" as const,
    accountId: "acc1",
    chatId: "!room1:example.com",
    agentId: "agent1",
    conversationId: "conv1",
  };

  await adapter.handleStreamReasoning?.("Reasoning about this...", [source]);
  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  // Turn ends without response
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "completed",
  });

  // NOT redacted — stays in room
  expect(client.redactEvent).not.toHaveBeenCalled();

  // Final edit goes through sendEvent now (MatrixSender.edit)
  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const editCall = client.sendEvent.mock.calls.find(
    (c) =>
      c[1] === "m.room.message" &&
      (
        (c[2] as Record<string, unknown>)["m.relates_to"] as Record<
          string,
          unknown
        >
      )?.event_id === "$thinking-1",
  );
  expect(editCall).toBeDefined();
  const ec = editCall![2] as Record<string, unknown>;
  expect(ec["m.relates_to"]).toMatchObject({
    rel_type: "m.replace",
    event_id: "$thinking-1",
  });
  const newContent = ec["m.new_content"] as Record<string, unknown>;
  expect(newContent.formatted_body as string).toContain("<b>Thinking</b>");
  expect(newContent.formatted_body as string).toContain("<blockquote>");
  expect(newContent.formatted_body as string).not.toContain("Thinking...");

  await adapter.stop();
});

test("matrix adapter: very long reasoning is sliding-window truncated to fit Matrix size cap", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$thinking-1"); // initial thinking placeholder

  const source = {
    channel: "matrix" as const,
    accountId: "acc1",
    chatId: "!room1:example.com",
    agentId: "agent1",
    conversationId: "conv1",
  };

  // 30k of plain ASCII reasoning — well over the 12k MATRIX_REASONING_MAX_CHARS cap.
  // Use distinct head/tail markers so we can prove which side was kept.
  const headMarker = "AAAAAAAAAA-very-early-thoughts-AAAAAAAAAA";
  const tailMarker = "ZZZZZZZZZZ-most-recent-conclusion-ZZZZZZZZZZ";
  const filler = "x".repeat(30_000);
  const longReasoning = `${headMarker}${filler}${tailMarker}`;

  await adapter.handleStreamReasoning?.(longReasoning, [source]);

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "completed",
  });

  // Initial thinking placeholder is sendMessage; final edit goes through sendEvent
  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const editCall = client.sendEvent.mock.calls.find(
    (c) =>
      c[1] === "m.room.message" &&
      (
        (c[2] as Record<string, unknown>)["m.relates_to"] as Record<
          string,
          unknown
        >
      )?.event_id === "$thinking-1",
  );
  expect(editCall).toBeDefined();
  const ec = editCall![2] as Record<string, unknown>;
  const newContent = ec["m.new_content"] as Record<string, unknown>;
  const editHtml = newContent.formatted_body as string;
  const editBody = newContent.body as string;

  // Sliding window: the *tail* is preserved, the *head* is dropped.
  expect(editBody).toContain(tailMarker);
  expect(editBody).not.toContain(headMarker);
  expect(editHtml).toContain(tailMarker);
  expect(editHtml).not.toContain(headMarker);

  // A truncation notice is prepended so the user knows content was clipped.
  expect(editBody).toContain("truncated");
  expect(editHtml).toContain("truncated");

  // The total formatted_body must comfortably fit under Matrix's 64 KiB
  // event-size limit even with HTML escaping and wrapper markup.
  expect(editHtml.length).toBeLessThan(60_000);

  await adapter.stop();
});

test("matrix adapter: short reasoning is NOT truncated (no notice)", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$thinking-1");

  const source = {
    channel: "matrix" as const,
    accountId: "acc1",
    chatId: "!room1:example.com",
    agentId: "agent1",
    conversationId: "conv1",
  };

  // Short reasoning — well under the cap, must pass through unchanged.
  await adapter.handleStreamReasoning?.("Just a brief thought.", [source]);

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "completed",
  });

  // Final edit goes through sendEvent (MatrixSender.edit)
  const editCall = client.sendEvent.mock.calls.find(
    (c) =>
      c[1] === "m.room.message" &&
      (
        (c[2] as Record<string, unknown>)["m.relates_to"] as Record<
          string,
          unknown
        >
      )?.event_id === "$thinking-1",
  );
  expect(editCall).toBeDefined();
  const newContent = (editCall![2] as Record<string, unknown>)[
    "m.new_content"
  ] as Record<string, unknown>;
  const editBody = newContent.body as string;

  expect(editBody).toContain("Just a brief thought.");
  expect(editBody).not.toContain("truncated");

  await adapter.stop();
});

test("matrix adapter: multi-run thinking within one turn is appended with separator", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$thinking-1") // initial thinking message
    .mockResolvedValueOnce("$tool-block-1") // tool block
    .mockResolvedValueOnce("$answer-1"); // response

  const source = {
    channel: "matrix" as const,
    accountId: "acc1",
    chatId: "!room1:example.com",
    agentId: "agent1",
    conversationId: "conv1",
  };

  // First reasoning segment
  await adapter.handleStreamReasoning?.("First thought.", [source]);
  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  // Tool call interrupts — marks separator needed
  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_call",
    batchId: "b1",
    toolName: "bash",
    sources: [source],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Second reasoning segment (after tool)
  await adapter.handleStreamReasoning?.("Second thought.", [source]);

  // ChannelAction tool call (response send) — skipped by adapter, no tool block
  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_call",
    batchId: "b1",
    toolName: "ChannelAction",
    sources: [source],
  });

  await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Here is the answer.",
  });

  // 3 sendMessage calls: thinking + tool block + answer
  expect(client.sendMessage).toHaveBeenCalledTimes(3);

  // Finalize at "finished"
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "b1",
    sources: [source],
    outcome: "completed",
  });

  // Still 3 sendMessage calls; finalize and footer now go through sendEvent
  expect(client.sendMessage).toHaveBeenCalledTimes(3);

  // Final edit of thinking message via sendEvent
  const thinkingEditCall = client.sendEvent.mock.calls.find(
    (c) =>
      c[1] === "m.room.message" &&
      (
        (c[2] as Record<string, unknown>)["m.relates_to"] as Record<
          string,
          unknown
        >
      )?.event_id === "$thinking-1",
  );
  expect(thinkingEditCall).toBeDefined();
  const ec = thinkingEditCall![2] as Record<string, unknown>;
  expect(ec["m.relates_to"]).toMatchObject({
    rel_type: "m.replace",
    event_id: "$thinking-1",
  });
  const newContent = ec["m.new_content"] as Record<string, unknown>;
  const editHtml = newContent.formatted_body as string;
  expect(editHtml).toContain("First thought.");
  expect(editHtml).toContain("Second thought.");
  expect(editHtml).toContain("<hr>"); // separator between segments

  // Completion footer edit via sendEvent
  const footerEditCall = client.sendEvent.mock.calls.find(
    (c) =>
      c[1] === "m.room.message" &&
      (
        (c[2] as Record<string, unknown>)["m.relates_to"] as Record<
          string,
          unknown
        >
      )?.event_id === "$answer-1",
  );
  expect(footerEditCall).toBeDefined();
  const fe = footerEditCall![2] as Record<string, unknown>;
  expect(fe["m.relates_to"]).toMatchObject({
    rel_type: "m.replace",
    event_id: "$answer-1",
  });

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
  // The formatted_body (HTML) contains the numbered list; body has it stripped to just the text
  const html = (call?.[1] as Record<string, unknown>).formatted_body as string;
  expect(html).toContain("default (current)");
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
    (c) => (c[1] as Record<string, unknown>).body === "Compaction triggered.",
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
          {
            id: "named-conv-1",
            agent_id: "agent-1",
            summary: "My Conv",
          } as unknown as Record<string, unknown>,
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
    (c) => (c[1] as Record<string, unknown>).body === "Switched to: My Conv.",
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
          {
            id: "named-conv-del",
            agent_id: "agent-1",
            summary: "To Delete",
          } as unknown as Record<string, unknown>,
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
          {
            id: "conv-cached",
            agent_id: "agent-1",
            summary: "Cached",
          } as unknown as Record<string, unknown>,
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
    (c) => (c[1] as Record<string, unknown>).body === "Switched to: Cached.",
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
  const switchAfterStop = client2.sendMessage.mock.calls.find((c) =>
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

  const helpCall = client.sendMessage.mock.calls.find((c) =>
    ((c[1] as Record<string, unknown>).body as string)?.includes("!cancel"),
  );
  expect(helpCall).toBeDefined();
  const body = (helpCall?.[1] as Record<string, unknown>).body as string;
  expect(body).toContain("!compact");
  expect(body).toContain("!conv list");
  expect(body).toContain("!help");
});

// ── Live tool-progress UI ─────────────────────────────────────────────────────
//
// All these tests bypass the production grace window (1 s before the running
// block becomes visible) by forcing it to 0 ms — see __testSetToolProgressGraceMs
// usage below. The suppression behavior under non-zero grace gets its own test.

async function setupToolProgressTestAdapter(graceMs = 0) {
  const adapterMod = await import("../../channels/matrix/adapter");
  adapterMod.__testSetToolProgressGraceMs(graceMs);
  const adapter = adapterMod.createMatrixAdapter(MATRIX_LIFECYCLE_ACCOUNT);
  await adapter.start();
  return adapter;
}

function getEditedFormattedBodies(client: FakeMatrixClient): string[] {
  const edits: string[] = [];
  // MatrixSender.edit now goes through sendEvent (not sendMessage)
  for (const call of client.sendEvent.mock.calls as Array<
    [string, string, Record<string, unknown>]
  >) {
    if (call[1] !== "m.room.message") continue;
    const content = call[2];
    const relatesTo = content["m.relates_to"] as
      | Record<string, unknown>
      | undefined;
    if (relatesTo?.rel_type !== "m.replace") continue;
    const newContent = content["m.new_content"] as
      | Record<string, unknown>
      | undefined;
    const html =
      (newContent?.formatted_body as string | undefined) ??
      (content.formatted_body as string | undefined) ??
      "";
    edits.push(html);
  }
  return edits;
}

test("Matrix tool progress: tool_started is a no-op shim (per-tool timing moved to Task 6)", async () => {
  // tool_started/tool_ended are no-op shims in Task 5. Per-tool timing
  // moves to ToolBlock in Task 6. No placeholder edits should occur.
  const adapter = await setupToolProgressTestAdapter();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValue("$placeholder");

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_started",
    batchId: "batch-1",
    toolCallId: "call-bash-1",
    toolName: "Bash",
    args: { command: "start-camofox.sh --headless" },
    timeoutMs: 120_000,
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await new Promise((r) => setTimeout(r, 50));

  // No placeholder edits — running-tool UI is removed from thinking block.
  const edits = getEditedFormattedBodies(client);
  expect(edits.filter((e) => e.includes("Running"))).toHaveLength(0);
});

test("Matrix tool progress: timeoutMs shim — no-op in Task 5 (Task 6 wires per-tool timing)", async () => {
  // timeoutMs will be rendered in ToolBlock (Task 6). In Task 5, tool_started
  // is a no-op shim — no placeholder edits occur.
  const adapter = await setupToolProgressTestAdapter();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValue("$placeholder");

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_started",
    batchId: "batch-1",
    toolCallId: "call-bash-2",
    toolName: "Bash",
    args: { command: "npm install", timeout: 600_000 },
    timeoutMs: 600_000,
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 50));

  // No placeholder created/edited (onToolStart is a no-op shim).
  expect(client.sendMessage).not.toHaveBeenCalled();
});

test("Matrix tool progress: no-timeout tool_started — no-op shim in Task 5", async () => {
  // Per-tool timing moves to ToolBlock in Task 6. In Task 5, tool_started
  // is a no-op shim — no placeholder edits occur.
  const adapter = await setupToolProgressTestAdapter();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValue("$placeholder");

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_started",
    batchId: "batch-1",
    toolCallId: "call-read-1",
    toolName: "Read",
    args: { file_path: "/etc/passwd" },
    sources: [MATRIX_LIFECYCLE_SOURCE],
    // no timeoutMs
  });
  await new Promise((r) => setTimeout(r, 50));

  // No placeholder created/edited (onToolStart is a no-op shim).
  const edits = getEditedFormattedBodies(client);
  expect(edits.filter((e) => e.includes("Running"))).toHaveLength(0);
});

test("Matrix tool progress: tool_ended no-op shim — per-tool annotation moves to ToolBlock in Task 6", async () => {
  // tool_ended is a no-op shim in Task 5. Per-tool `took m:ss` annotations
  // move to ToolBlock in Task 6. No placeholder edits occur.
  const adapter = await setupToolProgressTestAdapter();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValue("$placeholder");

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_started",
    batchId: "batch-1",
    toolCallId: "call-bash-3",
    toolName: "Bash",
    args: { command: "git status" },
    timeoutMs: 120_000,
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_ended",
    batchId: "batch-1",
    toolCallId: "call-bash-3",
    toolName: "Bash",
    durationMs: 107_000,
    outcome: "success",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 30));

  // No took-annotation in placeholder (moved to ToolBlock in Task 6).
  const edits = getEditedFormattedBodies(client);
  expect(edits.filter((e) => e.includes("took"))).toHaveLength(0);
});

test("Matrix tool progress: error outcome — no-op shim in Task 5 (errored annotation in ToolBlock, Task 6)", async () => {
  // Error annotation moves to ToolBlock in Task 6. In Task 5, no placeholder
  // edits occur for tool_started/tool_ended.
  const adapter = await setupToolProgressTestAdapter();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValue("$placeholder");

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_started",
    batchId: "batch-1",
    toolCallId: "call-bash-err",
    toolName: "Bash",
    args: { command: "false" },
    timeoutMs: 120_000,
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_ended",
    batchId: "batch-1",
    toolCallId: "call-bash-err",
    toolName: "Bash",
    durationMs: 4_500,
    outcome: "error",
    error: "exit 1",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 30));

  // No errored-after annotation (moved to ToolBlock in Task 6).
  const edits = getEditedFormattedBodies(client);
  expect(edits.filter((e) => e.includes("errored"))).toHaveLength(0);
});

test("Matrix tool progress: new tool_started — no-op shim in Task 5 (per-tool ordering in ToolBlock, Task 6)", async () => {
  // Per-tool annotations and ordering move to ToolBlock in Task 6. In Task 5,
  // tool_started/tool_ended are no-ops — no placeholder edits occur.
  const adapter = await setupToolProgressTestAdapter();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValue("$placeholder");

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_started",
    batchId: "batch-1",
    toolCallId: "call-1",
    toolName: "Bash",
    args: { command: "echo first" },
    timeoutMs: 120_000,
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_ended",
    batchId: "batch-1",
    toolCallId: "call-1",
    toolName: "Bash",
    durationMs: 1_000,
    outcome: "success",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_started",
    batchId: "batch-1",
    toolCallId: "call-2",
    toolName: "Read",
    args: { file_path: "/tmp/x" },
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 30));

  // No "Running" or "took" in placeholder (moved to ToolBlock in Task 6).
  const edits = getEditedFormattedBodies(client);
  expect(
    edits.filter((e) => e.includes("Running") || e.includes("took")),
  ).toHaveLength(0);
});

test("Matrix tool progress: secret redaction in args — no-op shim in Task 5 (args preview in ToolBlock, Task 6)", async () => {
  // Secret redaction in the args preview moves to ToolBlock in Task 6.
  // In Task 5, tool_started is a no-op — no placeholder edits occur.
  const adapter = await setupToolProgressTestAdapter();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValue("$placeholder");

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_started",
    batchId: "batch-1",
    toolCallId: "call-curl",
    toolName: "Bash",
    args: {
      command:
        "curl -H 'Authorization: Bearer sk-supersecret' --api-key=abcdef https://api.example.com",
    },
    timeoutMs: 120_000,
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 50));

  // No placeholder with secret content (onToolStart is a no-op shim).
  const edits = getEditedFormattedBodies(client);
  expect(edits.filter((e) => e.includes("sk-supersecret"))).toHaveLength(0);
});

test("Matrix tool progress: argsPreview truncation — no-op shim in Task 5 (preview in ToolBlock, Task 6)", async () => {
  // Args preview truncation moves to ToolBlock in Task 6. In Task 5,
  // tool_started is a no-op shim — no placeholder edits occur.
  const adapter = await setupToolProgressTestAdapter();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValue("$placeholder");

  const longCommand =
    "echo this is a very long command that should definitely exceed the eighty character preview limit imposed by buildArgsPreview";
  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_started",
    batchId: "batch-1",
    toolCallId: "call-long",
    toolName: "Bash",
    args: { command: longCommand },
    timeoutMs: 120_000,
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 50));

  // No placeholder with arg content (onToolStart is a no-op shim).
  expect(client.sendMessage).not.toHaveBeenCalled();
});

test("Matrix tool progress: ChannelAction and NotifyUser do not trigger tool-progress UI", async () => {
  const adapter = await setupToolProgressTestAdapter();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValue("$placeholder");

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_started",
    batchId: "batch-1",
    toolCallId: "call-ca",
    toolName: "ChannelAction",
    args: { action: "react", emoji: "👍" },
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 50));

  const edits = getEditedFormattedBodies(client);
  // No placeholder edits — ChannelAction is the bot's outbound channel path,
  // not work we're surfacing as "running".
  expect(edits.length).toBe(0);
});

test("Matrix tool progress: tool that completes inside grace window is invisible (no running, no annotation)", async () => {
  const adapter = await setupToolProgressTestAdapter(120); // 120 ms grace
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValue("$placeholder");

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_started",
    batchId: "batch-fast",
    toolCallId: "call-instant",
    toolName: "Read",
    args: { file_path: "/tmp/instant" },
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  // Tool ends well inside the 120 ms grace window.
  await new Promise((r) => setTimeout(r, 30));
  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_ended",
    batchId: "batch-fast",
    toolCallId: "call-instant",
    toolName: "Read",
    durationMs: 50,
    outcome: "success",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  // Wait past the grace window to confirm nothing fires after the fact.
  await new Promise((r) => setTimeout(r, 200));

  const edits = getEditedFormattedBodies(client);
  // No placeholder edits at all — neither running block nor took-annotation.
  expect(edits.length).toBe(0);
  // And no thinking placeholder was created either (since tool was suppressed
  // and there was no reasoning content).
  const placeholderCreates = (
    client.sendMessage.mock.calls as Array<[string, Record<string, unknown>]>
  ).filter((c) => c[1]["m.relates_to"] === undefined);
  expect(placeholderCreates.length).toBe(0);
});

test("Matrix tool progress: grace window — no-op shim in Task 5 (grace-based rendering in ToolBlock, Task 6)", async () => {
  // Grace-window rendering moves to ToolBlock in Task 6. In Task 5,
  // tool_started/tool_ended are no-op shims — no placeholder edits occur
  // regardless of grace window setting.
  const adapter = await setupToolProgressTestAdapter(50); // 50 ms grace
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValue("$placeholder");

  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_started",
    batchId: "batch-slow",
    toolCallId: "call-slow",
    toolName: "Bash",
    args: { command: "long-running-script" },
    timeoutMs: 120_000,
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 100));
  await adapter.handleTurnLifecycleEvent?.({
    type: "tool_ended",
    batchId: "batch-slow",
    toolCallId: "call-slow",
    toolName: "Bash",
    durationMs: 3_000,
    outcome: "success",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 30));

  // No running/took edits in placeholder (moved to ToolBlock in Task 6).
  const edits = getEditedFormattedBodies(client);
  expect(
    edits.filter((e) => e.includes("Running") || e.includes("took")),
  ).toHaveLength(0);
});

test("Matrix turn state: finished(error) with thinking block appends error footer in blockquote", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();

  client.sendMessage.mockResolvedValueOnce("$thinking-1"); // initial thinking placeholder

  await adapter.handleStreamReasoning?.("Checking email…", [
    MATRIX_LIFECYCLE_SOURCE,
  ]);
  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [MATRIX_LIFECYCLE_SOURCE],
    outcome: "error",
  });

  // Final edit goes through sendEvent now (MatrixSender.edit)
  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const editCall = client.sendEvent.mock.calls.find(
    (c) =>
      c[1] === "m.room.message" &&
      (
        (c[2] as Record<string, unknown>)["m.relates_to"] as Record<
          string,
          unknown
        >
      )?.event_id === "$thinking-1",
  );
  expect(editCall).toBeDefined();
  const editContent = editCall![2] as Record<string, unknown>;
  expect(editContent["m.relates_to"]).toMatchObject({
    rel_type: "m.replace",
    event_id: "$thinking-1",
  });

  const newContent = editContent["m.new_content"] as Record<string, unknown>;
  const html = newContent.formatted_body as string;
  expect(html).toContain("Checking email");
  expect(html).toContain('data-mx-color="#f85149"');
  expect(html).toContain("⚠ Turn failed");
  expect(html).not.toContain("✓");
});

test("Matrix turn state: finished(error) with no thinking block sends fallback error message", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();

  client.sendMessage.mockResolvedValueOnce("$fallback-error-1");

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [MATRIX_LIFECYCLE_SOURCE],
    outcome: "error",
  });

  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  const [room, content] = client.sendMessage.mock.calls[0] as [
    string,
    Record<string, unknown>,
  ];
  expect(room).toBe(MATRIX_LIFECYCLE_SOURCE.chatId);
  expect(content["m.relates_to"]).toBeUndefined();

  const html = content.formatted_body as string;
  expect(html).toContain('data-mx-color="#f85149"');
  expect(html).toContain("⚠ Turn failed");
  expect(html).toContain("didn't complete");
});

test("Matrix turn state: finished(cancelled) with thinking block appends cancelled footer", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();

  client.sendMessage.mockResolvedValueOnce("$thinking-1");

  await adapter.handleStreamReasoning?.("Drafting essay…", [
    MATRIX_LIFECYCLE_SOURCE,
  ]);
  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [MATRIX_LIFECYCLE_SOURCE],
    outcome: "cancelled",
  });

  // Final edit goes through sendEvent now (MatrixSender.edit)
  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const editCall = client.sendEvent.mock.calls.find(
    (c) =>
      c[1] === "m.room.message" &&
      (
        (c[2] as Record<string, unknown>)["m.relates_to"] as Record<
          string,
          unknown
        >
      )?.event_id === "$thinking-1",
  );
  expect(editCall).toBeDefined();
  const editContent = editCall![2] as Record<string, unknown>;
  expect(editContent["m.relates_to"]).toMatchObject({
    rel_type: "m.replace",
    event_id: "$thinking-1",
  });

  const newContent = editContent["m.new_content"] as Record<string, unknown>;
  const html = newContent.formatted_body as string;
  expect(html).toContain("Drafting essay");
  expect(html).toContain('data-mx-color="#e3b341"');
  expect(html).toContain("· Cancelled");
});

test("Matrix turn state: finished(cancelled) with no thinking block sends no extra message", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [MATRIX_LIFECYCLE_SOURCE],
    outcome: "cancelled",
  });

  expect(client.sendMessage).not.toHaveBeenCalled();
});

// ── Image / media handling ────────────────────────────────────────────────────

test("adapter handles non-E2EE image message and emits attachment with imageDataBase64", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg);
  };
  await adapter.start();
  const client = getFakeClient();

  // Provide a small PNG-like buffer as the "downloaded" image
  const fakeImageBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  client.downloadContent.mockResolvedValueOnce({
    data: fakeImageBytes,
    contentType: "image/png",
  });

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$img1",
    content: {
      msgtype: "m.image",
      url: "mxc://example.com/abc123",
      body: "photo.png",
      info: { mimetype: "image/png", size: fakeImageBytes.byteLength },
    },
  });

  expect(received).toHaveLength(1);
  expect(received[0]?.attachments).toHaveLength(1);
  const att = received[0]?.attachments?.[0];
  expect(att?.kind).toBe("image");
  expect(att?.mimeType).toBe("image/png");
  expect(att?.imageDataBase64).toBe(fakeImageBytes.toString("base64"));
  expect(att?.localPath).toMatch(/\.png$/);
  // text should be empty (body == filename with no separate caption)
  expect(received[0]?.text).toBe("");
  expect(client.downloadContent).toHaveBeenCalledWith(
    "mxc://example.com/abc123",
  );
});

test("adapter handles non-E2EE image with caption — caption becomes text", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg);
  };
  await adapter.start();
  const client = getFakeClient();

  const fakeImageBytes = Buffer.alloc(16, 0xff);
  client.downloadContent.mockResolvedValueOnce({
    data: fakeImageBytes,
    contentType: "image/jpeg",
  });

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$img2",
    content: {
      msgtype: "m.image",
      url: "mxc://example.com/xyz789",
      // MSC2530: filename is separate from body (caption)
      filename: "photo.jpg",
      body: "look at this",
      info: { mimetype: "image/jpeg", size: fakeImageBytes.byteLength },
    },
  });

  expect(received).toHaveLength(1);
  expect(received[0]?.text).toBe("look at this");
  expect(received[0]?.attachments).toHaveLength(1);
  expect(received[0]?.attachments?.[0]?.kind).toBe("image");
});

test("adapter handles E2EE image message (content.file) and decrypts attachment", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => {
    received.push(msg);
  };
  await adapter.start();
  const client = getFakeClient();

  // Generate a real AES-256-CTR key + IV and encrypt a small payload
  const plaintext = Buffer.from("fake image data 1234567890abcdef");
  const key = Buffer.alloc(32, 0xaa); // 256-bit key
  const iv = Buffer.alloc(16, 0); // 128-bit IV
  const cipher = createCipheriv("aes-256-ctr", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  // base64url-encode key and iv
  const toBase64Url = (buf: Buffer) =>
    buf
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

  client.downloadContent.mockResolvedValueOnce({
    data: Buffer.from(ciphertext),
    contentType: "application/octet-stream",
  });

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$e2ee-img1",
    content: {
      msgtype: "m.image",
      // No content.url — E2EE style
      body: "secret.jpg",
      info: { mimetype: "image/jpeg", size: plaintext.byteLength },
      file: {
        url: "mxc://example.com/encrypted456",
        key: {
          kty: "oct",
          key_ops: ["encrypt", "decrypt"],
          alg: "A256CTR",
          k: toBase64Url(key),
          ext: true,
        },
        iv: toBase64Url(iv),
        hashes: { sha256: "dGVzdA==" }, // not verified in current impl
        v: "v2",
      },
    },
  });

  expect(received).toHaveLength(1);
  expect(received[0]?.attachments).toHaveLength(1);
  const att = received[0]?.attachments?.[0];
  expect(att?.kind).toBe("image");
  // Decrypted content should equal the original plaintext
  expect(att?.imageDataBase64).toBe(plaintext.toString("base64"));
  expect(client.downloadContent).toHaveBeenCalledWith(
    "mxc://example.com/encrypted456",
  );
});

test("adapter skips E2EE image when content.file lacks key/iv (malformed)", async () => {
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
    event_id: "$bad-e2ee",
    content: {
      msgtype: "m.image",
      body: "broken.jpg",
      // file present but missing key/iv/hashes
      file: { url: "mxc://example.com/bad999" },
    },
  });

  // Should not emit — no text, no attachment (malformed E2EE)
  expect(received).toHaveLength(0);
  expect(client.downloadContent).not.toHaveBeenCalled();
});
