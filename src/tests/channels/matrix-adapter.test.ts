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

  constructor(homeserverUrl: string, accessToken: string) {
    this.homeserverUrl = homeserverUrl;
    this.accessToken = accessToken;
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
    ensureMatrixRuntimeInstalled: async () => true,
  }));

  mock.module("../../channels/config", () => ({
    getChannelDir: (channelId: string) => join(channelRoot, channelId),
    getChannelsRoot: () => channelRoot,
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
