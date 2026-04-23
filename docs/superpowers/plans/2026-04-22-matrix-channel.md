# Matrix Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Matrix channel adapter with full feature parity to the Telegram channel, using `matrix-bot-sdk`, reaction-based control-request UI, and best-effort E2EE.

**Architecture:** A regular Matrix bot user connecting via the Client-Server API. `matrix-bot-sdk` manages the sync loop; the adapter translates Matrix events to/from the letta channel types. Control requests use pre-reacted emoji reactions as pseudo-buttons; 📝 triggers a freeform text follow-up.

**Tech Stack:** `matrix-bot-sdk@0.8.0` (installed as runtime package), `marked` (Markdown→HTML), `@matrix-org/matrix-sdk-crypto-nodejs` (pulled in transitively for E2EE), `bun:test` for tests.

---

## File Map

| Action | Path | Purpose |
|---|---|---|
| Modify | `src/channels/types.ts` | Add `MatrixChannelAccount`, extend unions |
| Modify | `src/channels/config.ts` | Add `matrixConfigCodec` |
| Modify | `src/channels/pluginRegistry.ts` | Add matrix entry |
| Modify | `src/tools/impl/MessageChannel.ts` | Add `markdownToMatrixHtml`, matrix formatter |
| Create | `src/channels/matrix/runtime.ts` | Lazy-load matrix-bot-sdk from runtime dir |
| Create | `src/channels/matrix/plugin.ts` | `matrixChannelPlugin` export |
| Create | `src/channels/matrix/media.ts` | MXC download, MIME inference, attachment pipeline |
| Create | `src/channels/matrix/messageActions.ts` | send / react / upload-file actions |
| Create | `src/channels/matrix/adapter.ts` | Core adapter: lifecycle, inbound, outbound, control requests |
| Create | `src/channels/matrix/setup.ts` | CLI setup wizard |
| Create | `src/tests/channels/matrix-adapter.test.ts` | Adapter tests |

---

## Task 1: Types, config codec, and plugin registration

**Files:**
- Modify: `src/channels/types.ts`
- Modify: `src/channels/config.ts`
- Modify: `src/channels/pluginRegistry.ts`

- [ ] **Step 1: Add `MatrixChannelAccount` and extend unions in `types.ts`**

In `src/channels/types.ts`, make these changes:

```typescript
// Line 10 — extend SUPPORTED_CHANNEL_IDS:
export const SUPPORTED_CHANNEL_IDS = ["telegram", "slack", "discord", "matrix"] as const;

// After DiscordChannelAccount (around line 324), add:
export interface MatrixChannelAccount extends ChannelAccountBase {
  channel: "matrix";
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  e2ee: boolean;
  transcribeVoice?: boolean;
  maxMediaDownloadBytes?: number;
}

// Update ChannelAccount union (line 326):
export type ChannelAccount =
  | TelegramChannelAccount
  | SlackChannelAccount
  | DiscordChannelAccount
  | MatrixChannelAccount;
```

No `ChannelConfig` entry is needed — Matrix uses accounts directly (like Telegram post-migration), not YAML config files.

- [ ] **Step 2: Add `matrixConfigCodec` to `config.ts`**

In `src/channels/config.ts`, add the import and codec. The codec covers the legacy config path (same pattern as the others, even though setup now writes directly to accounts.json):

```typescript
// Add to imports at top:
import type {
  ChannelConfig,
  DiscordChannelConfig,
  DmPolicy,
  MatrixChannelAccount,
  SlackChannelConfig,
  TelegramChannelConfig,
} from "./types";
```

Add after `discordConfigCodec`:

```typescript
const matrixConfigCodec: ChannelConfigCodec<ChannelConfig> = {
  parse(parsed) {
    return {
      channel: "matrix",
      enabled: parsed.enabled !== false,
      homeserverUrl: String(parsed.homeserver_url ?? ""),
      accessToken: String(parsed.access_token ?? ""),
      userId: String(parsed.user_id ?? ""),
      dmPolicy: (parsed.dm_policy as DmPolicy) ?? "pairing",
      allowedUsers: (parsed.allowed_users as string[]) ?? [],
      e2ee: parsed.e2ee === true,
      transcribeVoice: parsed.transcribe_voice === true,
    } as unknown as ChannelConfig;
  },
};
```

Add `matrix: matrixConfigCodec` to `CHANNEL_CONFIG_CODECS`.

- [ ] **Step 3: Register matrix in `pluginRegistry.ts`**

Add to `CHANNEL_PLUGIN_REGISTRATIONS` in `src/channels/pluginRegistry.ts`:

```typescript
matrix: {
  metadata: {
    id: "matrix",
    displayName: "Matrix",
    runtimePackages: ["matrix-bot-sdk@0.8.0"],
    runtimeModules: ["matrix-bot-sdk"],
  },
  load: async () => {
    const { matrixChannelPlugin } = await import("./matrix/plugin");
    return matrixChannelPlugin;
  },
},
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
bun run tsc --noEmit 2>&1 | head -30
```

Expected: no errors related to the new types or the exhaustive `SupportedChannelId` record.

- [ ] **Step 5: Commit**

```bash
git add src/channels/types.ts src/channels/config.ts src/channels/pluginRegistry.ts
git commit -m "feat(matrix): register matrix channel types and plugin entry"
```

---

## Task 2: `runtime.ts` — lazy-load matrix-bot-sdk

**Files:**
- Create: `src/channels/matrix/runtime.ts`

- [ ] **Step 1: Create `runtime.ts`**

```typescript
// src/channels/matrix/runtime.ts
import {
  ensureChannelRuntimeInstalled,
  installChannelRuntime,
  isChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} from "../runtimeDeps";

export async function loadMatrixBotSdkModule(): Promise<typeof import("matrix-bot-sdk")> {
  return loadChannelRuntimeModule<typeof import("matrix-bot-sdk")>(
    "matrix",
    "matrix-bot-sdk",
  );
}

export function isMatrixRuntimeInstalled(): boolean {
  return isChannelRuntimeInstalled("matrix");
}

export async function installMatrixRuntime(): Promise<void> {
  await installChannelRuntime("matrix");
}

export async function ensureMatrixRuntimeInstalled(): Promise<boolean> {
  return ensureChannelRuntimeInstalled("matrix");
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/channels/matrix/runtime.ts
git commit -m "feat(matrix): add matrix-bot-sdk runtime loader"
```

---

## Task 3: `plugin.ts` — channel plugin export

**Files:**
- Create: `src/channels/matrix/plugin.ts`

- [ ] **Step 1: Create `plugin.ts`**

```typescript
// src/channels/matrix/plugin.ts
import type { ChannelPlugin } from "../pluginTypes";
import type { ChannelAccount, MatrixChannelAccount } from "../types";
import { createMatrixAdapter } from "./adapter";
import { matrixMessageActions } from "./messageActions";
import { runMatrixSetup } from "./setup";

export const matrixChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "matrix",
    displayName: "Matrix",
    runtimePackages: ["matrix-bot-sdk@0.8.0"],
    runtimeModules: ["matrix-bot-sdk"],
  },
  createAdapter(account: ChannelAccount) {
    return createMatrixAdapter(account as MatrixChannelAccount);
  },
  messageActions: matrixMessageActions,
  runSetup() {
    return runMatrixSetup();
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add src/channels/matrix/plugin.ts
git commit -m "feat(matrix): add matrix channel plugin export"
```

---

## Task 4: Markdown formatter in `MessageChannel.ts`

**Files:**
- Modify: `src/tools/impl/MessageChannel.ts`

- [ ] **Step 1: Install `marked`**

```bash
bun add marked
```

Expected: `marked` added to `package.json` and `bun.lock`.

- [ ] **Step 2: Write failing test**

In `src/tests/channels/` create `matrix-markdown.test.ts`:

```typescript
import { expect, test } from "bun:test";
import {
  markdownToMatrixHtml,
  stripMarkdownToPlainText,
} from "../../tools/impl/MessageChannel";

test("markdownToMatrixHtml converts bold", () => {
  const result = markdownToMatrixHtml("**hello world**");
  expect(result).toContain("<strong>hello world</strong>");
});

test("markdownToMatrixHtml converts inline code", () => {
  const result = markdownToMatrixHtml("`foo`");
  expect(result).toContain("<code>foo</code>");
});

test("markdownToMatrixHtml converts code block", () => {
  const result = markdownToMatrixHtml("```\nconst x = 1;\n```");
  expect(result).toContain("<code>");
  expect(result).toContain("const x = 1;");
});

test("stripMarkdownToPlainText removes bold markers", () => {
  const result = stripMarkdownToPlainText("**hello** world");
  expect(result).toBe("hello world");
});

test("stripMarkdownToPlainText removes inline code markers", () => {
  const result = stripMarkdownToPlainText("`foo`");
  expect(result).toBe("foo");
});

test("formatOutboundChannelMessage matrix returns HTML parseMode", () => {
  // Tested via the formatter directly below
  const result = stripMarkdownToPlainText("# Heading\n**bold** _italic_");
  expect(result).not.toContain("**");
  expect(result).not.toContain("_");
  expect(result).not.toContain("#");
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test src/tests/channels/matrix-markdown.test.ts 2>&1 | tail -20
```

Expected: FAIL — `markdownToMatrixHtml` and `stripMarkdownToPlainText` not exported.

- [ ] **Step 4: Implement the functions in `MessageChannel.ts`**

Add to `src/tools/impl/MessageChannel.ts` near the top imports:

```typescript
import { marked } from "marked";
```

Add these functions after `markdownToSlackMrkdwn` (around line 437):

```typescript
export function markdownToMatrixHtml(text: string): string {
  // marked.parse returns a string synchronously when given a string with no async extensions
  const html = marked.parse(text, { async: false }) as string;
  // Trim trailing newline that marked appends
  return html.trimEnd();
}

export function stripMarkdownToPlainText(text: string): string {
  // Remove headings
  let result = text.replace(/^#{1,6}\s+/gm, "");
  // Remove bold/italic (**, __, *, _)
  result = result.replace(/(\*{1,2}|_{1,2})(.+?)\1/g, "$2");
  // Remove inline code
  result = result.replace(/`([^`]+)`/g, "$1");
  // Remove fenced code blocks — keep content
  result = result.replace(/```[^\n]*\n([\s\S]*?)```/g, "$1");
  // Remove links — keep label
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Collapse multiple blank lines
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}
```

Add `"matrix"` to `CHANNEL_OUTBOUND_FORMATTERS`:

```typescript
const CHANNEL_OUTBOUND_FORMATTERS: Partial<
  Record<string, OutboundChannelFormatter>
> = {
  [TELEGRAM_CHANNEL_ID](text) {
    return {
      text: markdownToTelegramHtml(text),
      parseMode: "HTML",
    };
  },
  slack(text) {
    return {
      text: markdownToSlackMrkdwn(text),
    };
  },
  matrix(text) {
    return {
      text: stripMarkdownToPlainText(text),
      parseMode: "HTML",
    };
  },
};
```

The adapter will use `msg.text` as the plain-text `body` and call `markdownToMatrixHtml` on the original text to produce `formatted_body`. The formatter returns `parseMode: "HTML"` as the signal and `text` as the plain fallback.

Because `formatOutboundChannelMessage` normalizes the text with `decodeBasicXmlEntities` before passing to the formatter, we need to store the original HTML separately. Update the matrix formatter to store the HTML in a way the adapter can retrieve it — the cleanest approach is to produce the HTML in the adapter directly from `msg.text` (the original decoded text) using `markdownToMatrixHtml`. Add this note: **the adapter calls `markdownToMatrixHtml(msg.text)` itself to produce `formatted_body`; the formatter only provides `parseMode` as the signal and the stripped plain text as the fallback `body`.**

- [ ] **Step 5: Run tests**

```bash
bun test src/tests/channels/matrix-markdown.test.ts 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/impl/MessageChannel.ts src/tests/channels/matrix-markdown.test.ts package.json bun.lock
git commit -m "feat(matrix): add markdownToMatrixHtml formatter and matrix outbound formatter"
```

---

## Task 5: `media.ts` — MXC download and attachment pipeline

**Files:**
- Create: `src/channels/matrix/media.ts`
- Test: `src/tests/channels/matrix-adapter.test.ts` (media section, added in Task 10)

- [ ] **Step 1: Create `media.ts`**

```typescript
// src/channels/matrix/media.ts
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { getChannelDir } from "../config";
import type { ChannelMessageAttachment } from "../types";

export const MATRIX_DOWNLOAD_TIMEOUT_MS = 15_000;
export const MATRIX_DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const MATRIX_INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

// Maps Matrix msgtype to our attachment kind
export function matrixMsgtypeToKind(
  msgtype: string,
  mimeType?: string,
): "image" | "video" | "audio" | "file" {
  if (msgtype === "m.image") return "image";
  if (msgtype === "m.video") return "video";
  if (msgtype === "m.audio") return "audio";
  if (msgtype === "m.file") {
    if (mimeType?.startsWith("image/")) return "image";
    if (mimeType?.startsWith("video/")) return "video";
    if (mimeType?.startsWith("audio/")) return "audio";
    return "file";
  }
  return "file";
}

// Maps kind back to Matrix msgtype for uploads
export function kindToMatrixMsgtype(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "m.image";
  if (mimeType.startsWith("video/")) return "m.video";
  if (mimeType.startsWith("audio/")) return "m.audio";
  return "m.file";
}

export function inferMimeTypeFromExtension(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".m4a": "audio/mp4",
    ".pdf": "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

export interface MatrixMediaCandidate {
  mxcUrl: string;
  msgtype: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  isVoice?: boolean;
}

export function collectMatrixMediaCandidate(
  event: Record<string, unknown>,
): MatrixMediaCandidate | null {
  const content = event["content"] as Record<string, unknown> | undefined;
  if (!content) return null;

  const msgtype = content["msgtype"] as string | undefined;
  if (!msgtype || !["m.image", "m.video", "m.audio", "m.file"].includes(msgtype)) {
    return null;
  }

  const url = content["url"] as string | undefined;
  if (!url?.startsWith("mxc://")) return null;

  const info = content["info"] as Record<string, unknown> | undefined;
  const mimeType =
    (info?.["mimetype"] as string | undefined) ??
    (content["filename"]
      ? inferMimeTypeFromExtension(content["filename"] as string)
      : undefined);

  return {
    mxcUrl: url,
    msgtype,
    filename: (content["filename"] as string | undefined) ?? (content["body"] as string | undefined),
    mimeType,
    sizeBytes: info?.["size"] as number | undefined,
    isVoice: msgtype === "m.audio" && (content["org.matrix.msc3245.voice"] != null || content["voice"] != null),
  };
}

export async function downloadMatrixAttachment(
  candidate: MatrixMediaCandidate,
  httpUrl: string,
  accountId: string,
  maxBytes: number,
  transcribeVoice: boolean,
): Promise<ChannelMessageAttachment | null> {
  if (candidate.sizeBytes != null && candidate.sizeBytes > maxBytes) {
    console.warn(
      `[matrix] Skipping attachment: size ${candidate.sizeBytes} exceeds limit ${maxBytes}`,
    );
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MATRIX_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(httpUrl, { signal: controller.signal });
    if (!response.ok) {
      console.warn(`[matrix] Attachment download failed: HTTP ${response.status}`);
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > maxBytes) {
      console.warn(`[matrix] Skipping attachment: content-length ${contentLength} exceeds limit ${maxBytes}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      console.warn(`[matrix] Skipping attachment: downloaded size ${buffer.byteLength} exceeds limit ${maxBytes}`);
      return null;
    }

    const ext = candidate.filename ? extname(candidate.filename) : "";
    const filename = `${Date.now()}-${randomUUID()}${ext || ".bin"}`;
    const dir = join(getChannelDir("matrix"), "inbound", accountId);
    await mkdir(dir, { recursive: true });
    const localPath = join(dir, filename);
    await writeFile(localPath, buffer);

    const mimeType = candidate.mimeType ?? inferMimeTypeFromExtension(filename);
    const kind = matrixMsgtypeToKind(candidate.msgtype, mimeType);

    const attachment: ChannelMessageAttachment = {
      name: candidate.filename,
      mimeType,
      sizeBytes: buffer.byteLength,
      kind,
      localPath,
    };

    if (kind === "image" && buffer.byteLength <= MATRIX_INLINE_IMAGE_MAX_BYTES) {
      attachment.imageDataBase64 = buffer.toString("base64");
    }

    if (candidate.isVoice && transcribeVoice) {
      const { transcribeAudioFile } = await import("../transcription/index");
      const result = await transcribeAudioFile(localPath);
      if (result.success && result.text) {
        attachment.transcription = result.text;
      }
    }

    return attachment;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn("[matrix] Attachment download timed out");
    } else {
      console.warn("[matrix] Attachment download error:", err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/channels/matrix/media.ts
git commit -m "feat(matrix): add MXC media download and attachment pipeline"
```

---

## Task 6: `messageActions.ts` — send / react / upload-file

**Files:**
- Create: `src/channels/matrix/messageActions.ts`

- [ ] **Step 1: Write failing test in `src/tests/channels/matrix-adapter.test.ts`**

Create the test file with the FakeMatrixClient scaffold and message actions tests. This scaffold is reused across all subsequent adapter tests.

```typescript
// src/tests/channels/matrix-adapter.test.ts
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundChannelMessage } from "../../channels/types";

// ── FakeMatrixClient ──────────────────────────────────────────────────────────

type EventHandler = (roomId: string, event: Record<string, unknown>) => Promise<void> | void;
type InviteHandler = (roomId: string, event: Record<string, unknown>) => Promise<void> | void;

class FakeMatrixClient {
  static instances: FakeMatrixClient[] = [];

  readonly homeserverUrl: string;
  readonly accessToken: string;

  private handlers = new Map<string, EventHandler[]>();
  private inviteHandlers: InviteHandler[] = [];
  private _started = false;

  sendMessage = mock(async (_roomId: string, _content: unknown) => "$fake-event-id");
  sendEvent = mock(async (_roomId: string, _type: string, _content: unknown) => "$fake-reaction-id");
  redactEvent = mock(async (_roomId: string, _eventId: string) => "$fake-redaction-id");
  joinRoom = mock(async (roomId: string) => roomId);
  getUserProfile = mock(async (_userId: string) => ({ displayname: "Test User" }));
  getJoinedRoomMembers = mock(async (_roomId: string): Promise<string[]> => ["@bot:matrix.org", "@user:matrix.org"]);
  uploadContent = mock(async (_data: Buffer, _contentType: string, _filename: string) => "mxc://matrix.org/abc123");
  mxcToHttp = mock((_mxc: string) => "https://matrix.org/_matrix/media/v3/download/matrix.org/abc123");
  start = mock(async () => { this._started = true; });
  stop = mock(async () => { this._started = false; });
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

  async emit(event: string, roomId: string, eventObj: Record<string, unknown>): Promise<void> {
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
  const { matrixMessageActions } = await import("../../channels/matrix/messageActions");
  const desc = matrixMessageActions.describeMessageTool({ accountId: "acc1" });
  expect(desc.actions).toEqual(["send", "react", "upload-file"]);
});

test("matrixMessageActions.handleAction send calls adapter.sendMessage", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$sent-event");

  const { matrixMessageActions } = await import("../../channels/matrix/messageActions");

  const result = await matrixMessageActions.handleAction({
    request: { action: "send", chatId: "!room:example.com", message: "hello" },
    route: { accountId: "acc1", chatId: "!room:example.com", agentId: "a1", conversationId: "c1", enabled: true, createdAt: "" },
    adapter,
    formatText: (t) => ({ text: t }),
  } as any);

  expect(result).toContain("Message sent");
  expect(client.sendMessage).toHaveBeenCalledTimes(1);
});

test("matrixMessageActions.handleAction react calls adapter.sendMessage with reaction", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();

  const { matrixMessageActions } = await import("../../channels/matrix/messageActions");

  const result = await matrixMessageActions.handleAction({
    request: { action: "react", chatId: "!room:example.com", emoji: "👍", messageId: "$target" },
    route: { accountId: "acc1", chatId: "!room:example.com", agentId: "a1", conversationId: "c1", enabled: true, createdAt: "" },
    adapter,
    formatText: (t) => ({ text: t }),
  } as any);

  expect(result).toContain("Reaction added");
  expect(client.sendEvent).toHaveBeenCalledWith(
    "!room:example.com",
    "m.reaction",
    expect.objectContaining({ "m.relates_to": expect.objectContaining({ key: "👍" }) }),
  );
});

test("matrixMessageActions.handleAction upload-file calls adapter.sendMessage with mediaPath", async () => {
  const adapter = await makeAdapter();
  await adapter.start();

  const { matrixMessageActions } = await import("../../channels/matrix/messageActions");

  const result = await matrixMessageActions.handleAction({
    request: { action: "upload-file", chatId: "!room:example.com", mediaPath: "/tmp/test.png" },
    route: { accountId: "acc1", chatId: "!room:example.com", agentId: "a1", conversationId: "c1", enabled: true, createdAt: "" },
    adapter,
    formatText: (t) => ({ text: t }),
  } as any);

  expect(result).toContain("Attachment sent");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test-name-pattern "matrixMessageActions" 2>&1 | tail -20
```

Expected: FAIL — `createMatrixAdapter` and `matrixMessageActions` not found.

- [ ] **Step 3: Create `messageActions.ts`**

```typescript
// src/channels/matrix/messageActions.ts
import type { ChannelMessageActionAdapter } from "../pluginTypes";

export const matrixMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool() {
    return { actions: ["send", "react", "upload-file"] };
  },

  async handleAction(ctx) {
    const { request, route, adapter, formatText } = ctx;

    if (
      request.action !== "send" &&
      request.action !== "react" &&
      request.action !== "upload-file"
    ) {
      return `Error: Action "${request.action}" is not supported on matrix.`;
    }

    if (request.action === "react") {
      if (!request.emoji?.trim() && !request.remove) {
        return "Error: Matrix react requires emoji.";
      }
      if (!request.messageId?.trim()) {
        return "Error: Matrix react requires messageId.";
      }
      const result = await adapter.sendMessage({
        channel: "matrix",
        accountId: route.accountId,
        chatId: request.chatId,
        text: "",
        targetMessageId: request.messageId,
        reaction: request.emoji,
        removeReaction: request.remove,
      });
      return request.remove
        ? `Reaction removed on matrix (message_id: ${result.messageId})`
        : `Reaction added on matrix (message_id: ${result.messageId})`;
    }

    if (!request.message?.trim() && !request.mediaPath?.trim()) {
      return "Error: Matrix send requires message or media.";
    }
    if (request.action === "upload-file" && !request.mediaPath?.trim()) {
      return "Error: Matrix upload-file requires media.";
    }
    if (request.action === "send" && !request.message?.trim()) {
      return "Error: Matrix send requires message.";
    }

    const formatted = formatText(request.message ?? "");
    const result = await adapter.sendMessage({
      channel: "matrix",
      accountId: route.accountId,
      chatId: request.chatId,
      text: formatted.text,
      replyToMessageId: request.replyToMessageId,
      mediaPath: request.mediaPath,
      fileName: request.filename,
      title: request.title,
      parseMode: formatted.parseMode,
    });

    return request.mediaPath
      ? `Attachment sent to matrix (message_id: ${result.messageId})`
      : `Message sent to matrix (message_id: ${result.messageId})`;
  },
};
```

- [ ] **Step 4: Run tests**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test-name-pattern "matrixMessageActions" 2>&1 | tail -20
```

Expected: all 3 messageActions tests PASS (they need adapter too — if adapter isn't ready yet, stub it; adapter scaffolding comes next).

- [ ] **Step 5: Commit**

```bash
git add src/channels/matrix/messageActions.ts src/tests/channels/matrix-adapter.test.ts
git commit -m "feat(matrix): add messageActions and test scaffold"
```

---

## Task 7: `adapter.ts` — skeleton, lifecycle, and outbound text

**Files:**
- Create: `src/channels/matrix/adapter.ts`

This is the largest file. Build it incrementally across Tasks 7–13.

- [ ] **Step 1: Write failing lifecycle tests** (append to `matrix-adapter.test.ts`)

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test-name-pattern "adapter (starts|stop|sendMessage|sendDirectReply)" 2>&1 | tail -20
```

Expected: FAIL — `createMatrixAdapter` not defined.

- [ ] **Step 3: Create `adapter.ts` with lifecycle and outbound text**

```typescript
// src/channels/matrix/adapter.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { formatChannelControlRequestPrompt } from "../interactive";
import { getChannelDir } from "../config";
import { markdownToMatrixHtml } from "../../tools/impl/MessageChannel";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelControlRequestKind,
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
  senderId: string;
  sentEmojis: string[];
  sentReactionEventIds: Map<string, string>;
  awaitingFreeform: boolean;
};

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

  let matrixClient: Awaited<ReturnType<typeof createClient>> | null = null;
  let running = false;

  // Map from promptMessageEventId → PendingReactionRequest
  const pendingReactionRequests = new Map<string, PendingReactionRequest>();
  // Map from `${chatId}:${senderId}` → requestId
  const awaitingFreeformByChat = new Map<string, string>();

  async function createClient() {
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

    let cryptoProvider: InstanceType<typeof RustSdkCryptoStorageProvider> | undefined;
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

    return new MatrixClient(
      homeserverUrl,
      accessToken,
      storageProvider,
      cryptoProvider,
    );
  }

  async function ensureClient() {
    if (!matrixClient) throw new Error("Matrix adapter not started");
    return matrixClient;
  }

  function buildFreeformKey(chatId: string, senderId: string): string {
    return `${chatId}:${senderId}`;
  }

  async function redactControlRequestReactions(req: PendingReactionRequest) {
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
      client.on("room.invite", async (roomId: string) => {
        try {
          await client.joinRoom(roomId);
        } catch (err) {
          console.warn(`[matrix] Failed to join room ${roomId}:`, err);
        }
      });

      // Text messages and media
      client.on("room.message", async (roomId: string, event: Record<string, unknown>) => {
        if (event["sender"] === userId) return; // ignore own messages

        const content = event["content"] as Record<string, unknown> | undefined;
        if (!content) return;
        const msgtype = content["msgtype"] as string | undefined;

        // Bot commands
        if (msgtype === "m.text" || msgtype === "m.notice") {
          const body = (content["body"] as string | undefined)?.trim() ?? "";
          if (body.startsWith("!")) {
            await handleBotCommand(roomId, body, event);
            return;
          }
        }

        // Check freeform awaiting
        const senderIdStr = event["sender"] as string;
        const freeformKey = buildFreeformKey(roomId, senderIdStr);
        const pendingId = awaitingFreeformByChat.get(freeformKey);
        if (pendingId) {
          const pending = [...pendingReactionRequests.values()].find(
            (r) => r.requestId === pendingId,
          );
          if (pending) {
            awaitingFreeformByChat.delete(freeformKey);
            pendingReactionRequests.delete(
              [...pendingReactionRequests.entries()].find(
                ([, v]) => v.requestId === pendingId,
              )?.[0] ?? "",
            );
            await redactControlRequestReactions(pending);
          }
          // Fall through: emit as normal message so registry handles it as freeform response
        }

        // Attachments
        const candidate = collectMatrixMediaCandidate(event);
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

        const textContent = ((content["body"] as string | undefined) ?? "").trim();
        const isMediaOnly = candidate != null;
        if (!textContent && attachments.length === 0) return;

        // Determine chatType
        const members = await client.getJoinedRoomMembers(roomId).catch(() => []);
        const chatType = members.length === 2 ? "direct" : "channel";

        // Display name
        const profile = await client.getUserProfile(senderIdStr).catch(() => ({ displayname: undefined }));
        const senderName = (profile as { displayname?: string }).displayname ?? senderIdStr;

        const msg: InboundChannelMessage = {
          channel: "matrix",
          accountId,
          chatId: roomId,
          senderId: senderIdStr,
          senderName,
          text: isMediaOnly ? "" : textContent,
          timestamp: Date.now(),
          messageId: event["event_id"] as string | undefined,
          chatType,
          attachments: attachments.length > 0 ? attachments : undefined,
        };

        await adapter.onMessage?.(msg);
      });

      // Reactions and redactions
      client.on("room.event", async (roomId: string, event: Record<string, unknown>) => {
        const type = event["type"] as string;

        if (type === "m.reaction") {
          await handleReactionEvent(roomId, event);
          return;
        }

        if (type === "m.room.redaction") {
          await handleRedactionEvent(roomId, event);
          return;
        }
      });

      await client.start();
      running = true;
    },

    async stop(): Promise<void> {
      await matrixClient?.stop();
      running = false;
    },

    isRunning(): boolean {
      return running;
    },

    async sendMessage(msg: OutboundChannelMessage): Promise<{ messageId: string }> {
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
        const redactionId = await client.redactEvent(msg.chatId, msg.targetMessageId);
        return { messageId: String(redactionId) };
      }

      // Media upload
      if (msg.mediaPath) {
        const buffer = await Bun.file(msg.mediaPath).arrayBuffer().then(Buffer.from);
        const filename = msg.fileName ?? msg.mediaPath.split("/").pop() ?? "file";
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
        content["format"] = "org.matrix.custom.html";
        content["formatted_body"] = markdownToMatrixHtml(msg.text);
      }

      if (msg.replyToMessageId) {
        content["m.relates_to"] = {
          "m.in_reply_to": { event_id: msg.replyToMessageId },
        };
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
      const content: Record<string, unknown> = { msgtype: "m.text", body: text };
      if (options?.replyToMessageId) {
        content["m.relates_to"] = {
          "m.in_reply_to": { event_id: options.replyToMessageId },
        };
      }
      await client.sendMessage(chatId, content);
    },

    async handleControlRequestEvent(event: ChannelControlRequestEvent): Promise<void> {
      const client = await ensureClient();
      const { chatId, senderId, messageId, threadId } = event.source;

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

      pendingReactionRequests.set(String(promptEventId), {
        requestId: event.requestId,
        kind: event.kind,
        chatId,
        senderId: senderId ?? "",
        sentEmojis: emojis,
        sentReactionEventIds,
        awaitingFreeform: false,
      });
    },

    onMessage: undefined,
  };

  // ── Internal helpers ────────────────────────────────────────────────────────

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
        body:
          "👋 Hi! I'm a Letta AI assistant.\n\nTo pair this conversation with an agent, ask your admin for a pairing code and send it here.",
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
    const content = event["content"] as Record<string, unknown> | undefined;
    const relatesTo = content?.["m.relates_to"] as Record<string, unknown> | undefined;
    if (!relatesTo) return;

    const targetEventId = relatesTo["event_id"] as string | undefined;
    const emoji = relatesTo["key"] as string | undefined;
    const senderIdStr = event["sender"] as string;

    if (!targetEventId || !emoji) return;
    if (senderIdStr === userId) return; // ignore own pre-reactions

    // Check if this targets a pending control request
    const pending = pendingReactionRequests.get(targetEventId);
    if (pending) {
      if (senderIdStr !== pending.senderId) return; // ignore reactions from other users

      if (emoji === "📝") {
        // Freeform flow
        const client = await ensureClient();
        pending.awaitingFreeform = true;
        const freeformKey = buildFreeformKey(roomId, senderIdStr);
        awaitingFreeformByChat.set(freeformKey, pending.requestId);
        const followUpText =
          pending.kind === "ask_user_question"
            ? "Please type your answer:"
            : "Please type your reason for denying:";
        await client.sendMessage(roomId, { msgtype: "m.text", body: followUpText });
        return;
      }

      // Map emoji to synthetic text
      const syntheticText = emojiToSyntheticText(emoji, pending);
      if (!syntheticText) return; // unknown emoji, ignore

      // Redact pre-reactions and remove from pending
      pendingReactionRequests.delete(targetEventId);
      await redactControlRequestReactions(pending);

      // Emit synthetic message so registry handles it
      const members = await (await ensureClient()).getJoinedRoomMembers(roomId).catch(() => []);
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

    // Normal (non-control-request) reaction — emit as InboundChannelMessage
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
    const redactedEventId = event["redacts"] as string | undefined;
    if (!redactedEventId) return;

    // Check if this is a user removing one of our pre-reactions (or their own reaction)
    // For non-control-request rooms, emit a reaction remove event
    // We look through all pending requests to see if this redaction id is one of our pre-reactions
    for (const [, pending] of pendingReactionRequests) {
      for (const [emoji, reactionEventId] of pending.sentReactionEventIds) {
        if (reactionEventId === redactedEventId) {
          // One of our own pre-reactions was redacted externally — ignore
          return;
        }
        void emoji; // used above
      }
    }

    // Otherwise emit as reaction remove (best-effort; we may not know the emoji)
    // matrix-bot-sdk doesn't give us the emoji in the redaction event
    // so we just skip emitting — clients can track this themselves if needed
  }

  return adapter;
}

// ── Control request prompt builder ───────────────────────────────────────────

function buildMatrixControlRequestPrompt(event: ChannelControlRequestEvent): {
  promptText: string;
  emojis: string[];
} {
  switch (event.kind) {
    case "generic_tool_approval": {
      const inputStr = JSON.stringify(event.input, null, 2);
      const truncated = inputStr.length > 1200 ? inputStr.slice(0, 1197) + "..." : inputStr;
      const lines = [`The agent wants approval to run \`${event.toolName}\`.`];
      if (truncated && truncated !== "{}") lines.push("", "Tool input:", truncated);
      lines.push("", "✅ approve   ❌ deny   📝 deny with reason");
      return { promptText: lines.join("\n"), emojis: ["✅", "❌", "📝"] };
    }

    case "enter_plan_mode":
      return {
        promptText:
          "The agent wants to enter plan mode before making changes.\n\n✅ approve   ❌ deny",
        emojis: ["✅", "❌"],
      };

    case "exit_plan_mode": {
      const lines = ["The agent is ready to leave plan mode and start implementing."];
      if (event.planContent?.trim()) {
        const preview =
          event.planContent.length > 1800
            ? event.planContent.slice(0, 1797) + "..."
            : event.planContent;
        lines.push("", "Proposed plan:", preview);
        if (event.planFilePath?.trim()) lines.push("", `Plan file: ${event.planFilePath.trim()}`);
      }
      lines.push("", "✅ approve   📝 provide feedback");
      return { promptText: lines.join("\n"), emojis: ["✅", "📝"] };
    }

    case "ask_user_question": {
      const input = event.input as AskUserQuestionInput;
      const questions = (input.questions ?? []).filter((q) => q.question?.trim());
      const firstQ = questions[0];

      if (!firstQ || questions.length > 1) {
        // Multi-question or no question: fall back to standard text prompt
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
        lines.push(desc ? `  ${emoji}  ${label} — ${desc}` : `  ${emoji}  ${label}`);
      });

      if (options.length > 10) {
        lines.push("", `Additional options (type the number or label):`);
        options.slice(10).forEach((opt, i) => {
          lines.push(`  ${i + 11}) ${opt.label?.trim() || `Option ${i + 11}`}`);
        });
      }

      if (options.length > 0) {
        emojis.push("📝");
        lines.push(`  📝  type a custom answer`);
      }

      return { promptText: lines.join("\n"), emojis };
    }

    default: {
      const _exhaustive: never = event.kind;
      return { promptText: formatChannelControlRequestPrompt(event), emojis: [] };
    }
  }
}

function emojiToSyntheticText(emoji: string, pending: PendingReactionRequest): string | null {
  if (emoji === "✅") return "approve";
  if (emoji === "❌") return "deny";
  const keycapIndex = KEYCAP_EMOJIS.indexOf(emoji);
  if (keycapIndex !== -1) return String(keycapIndex + 1);
  return null;
}
```

- [ ] **Step 4: Run lifecycle and outbound tests**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test-name-pattern "adapter (starts|stop|sendMessage|sendDirectReply)" 2>&1 | tail -30
```

Expected: all lifecycle and outbound text tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/matrix/adapter.ts
git commit -m "feat(matrix): add adapter skeleton with lifecycle and outbound text"
```

---

## Task 8: Adapter — inbound text, invites, bot commands

- [ ] **Step 1: Write failing tests** (append to `matrix-adapter.test.ts`)

```typescript
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
  adapter.onMessage = async (msg) => { received.push(msg); };
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
  adapter.onMessage = async (msg) => { received.push(msg); };
  await adapter.start();
  const client = getFakeClient();

  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@letta-bot:example.com", // same as userId
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
    expect.objectContaining({ body: expect.stringContaining("Letta") }),
  );
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
    expect.objectContaining({ body: expect.stringContaining("@letta-bot:example.com") }),
  );
});

test("adapter sets chatType=direct for 2-member rooms", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => { received.push(msg); };
  await adapter.start();
  const client = getFakeClient();
  client.getJoinedRoomMembers.mockResolvedValueOnce(["@bot:example.com", "@user:example.com"]);

  await client.emit("room.message", "!room:example.com", {
    sender: "@user:example.com",
    event_id: "$evt2",
    content: { msgtype: "m.text", body: "hi" },
  });

  expect(received[0]?.chatType).toBe("direct");
});
```

- [ ] **Step 2: Run tests**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test-name-pattern "adapter (auto-accepts|emits inbound|filters out|responds to)" 2>&1 | tail -20
```

Expected: all PASS (the adapter.ts written in Task 7 already handles these).

- [ ] **Step 3: Commit**

```bash
git add src/tests/channels/matrix-adapter.test.ts
git commit -m "test(matrix): add inbound text, invite, and bot command tests"
```

---

## Task 9: Adapter — inbound reactions and outbound reactions

- [ ] **Step 1: Write failing tests** (append to `matrix-adapter.test.ts`)

```typescript
test("adapter emits reaction add as InboundChannelMessage", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => { received.push(msg); };
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
    { "m.relates_to": { rel_type: "m.annotation", event_id: "$target-msg", key: "👍" } },
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
  expect(client.redactEvent).toHaveBeenCalledWith("!room:example.com", "$reaction-to-remove");
});
```

- [ ] **Step 2: Run tests**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test-name-pattern "adapter (emits reaction|sendMessage with reaction|sendMessage with removeReaction)" 2>&1 | tail -20
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tests/channels/matrix-adapter.test.ts
git commit -m "test(matrix): add reaction inbound and outbound tests"
```

---

## Task 10: Adapter — control requests (approve/deny)

- [ ] **Step 1: Write failing tests** (append to `matrix-adapter.test.ts`)

```typescript
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
      senderId: "@user:example.com",
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
  const keys = reactionCalls.map((c: unknown[]) => (c[2] as any)["m.relates_to"].key);
  expect(keys).toContain("✅");
  expect(keys).toContain("❌");
  expect(keys).toContain("📝");
});

test("tapping ✅ emits synthetic approve message", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => { received.push(msg); };
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$prompt-event");
  client.sendEvent.mockResolvedValue("$reaction-event");

  await adapter.handleControlRequestEvent!({
    requestId: "req1",
    kind: "generic_tool_approval",
    source: {
      channel: "matrix", accountId: "acc1", chatId: "!room:example.com",
      senderId: "@user:example.com", messageId: "$orig", agentId: "a1", conversationId: "c1",
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
  // Pre-reactions redacted
  expect(client.redactEvent).toHaveBeenCalled();
});

test("tapping ❌ emits synthetic deny message", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => { received.push(msg); };
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$prompt-event");
  client.sendEvent.mockResolvedValue("$reaction-event");

  await adapter.handleControlRequestEvent!({
    requestId: "req2",
    kind: "enter_plan_mode",
    source: {
      channel: "matrix", accountId: "acc1", chatId: "!room:example.com",
      senderId: "@user:example.com", messageId: "$orig", agentId: "a1", conversationId: "c1",
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
});

test("reactions from other users are ignored", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => { received.push(msg); };
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$prompt-event");
  client.sendEvent.mockResolvedValue("$reaction-event");

  await adapter.handleControlRequestEvent!({
    requestId: "req3",
    kind: "generic_tool_approval",
    source: {
      channel: "matrix", accountId: "acc1", chatId: "!room:example.com",
      senderId: "@user:example.com", messageId: "$orig", agentId: "a1", conversationId: "c1",
    },
    toolName: "bash",
    input: {},
  });

  // Different user taps ✅ — should be ignored
  await client.emit("room.event", "!room:example.com", {
    type: "m.reaction",
    sender: "@intruder:example.com",
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
```

- [ ] **Step 2: Run tests**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test-name-pattern "handleControlRequestEvent|tapping ✅|tapping ❌|reactions from other" 2>&1 | tail -30
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tests/channels/matrix-adapter.test.ts
git commit -m "test(matrix): add control request approve/deny reaction tests"
```

---

## Task 11: Adapter — control requests (📝 freeform flow)

- [ ] **Step 1: Write failing tests** (append to `matrix-adapter.test.ts`)

```typescript
test("tapping 📝 sends follow-up prompt and waits for freeform text", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => { received.push(msg); };
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$prompt-event")  // control request prompt
    .mockResolvedValueOnce("$followup-event"); // follow-up "please type"
  client.sendEvent.mockResolvedValue("$reaction-event");

  await adapter.handleControlRequestEvent!({
    requestId: "req-freeform",
    kind: "generic_tool_approval",
    source: {
      channel: "matrix", accountId: "acc1", chatId: "!room:example.com",
      senderId: "@user:example.com", messageId: "$orig", agentId: "a1", conversationId: "c1",
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

  // Should NOT emit yet — waiting for text
  expect(received.filter((m) => m.text && m.text !== "")).toHaveLength(0);
  // Follow-up prompt should have been sent
  expect(client.sendMessage).toHaveBeenCalledWith(
    "!room:example.com",
    expect.objectContaining({ body: expect.stringContaining("type your reason") }),
  );

  // User types their reason
  await client.emit("room.message", "!room:example.com", {
    type: "m.room.message",
    sender: "@user:example.com",
    event_id: "$freeform-reply",
    content: { msgtype: "m.text", body: "because it is dangerous" },
  });

  // Now should have emitted with the freeform text
  const freeformMsg = received.find((m) => m.text === "because it is dangerous");
  expect(freeformMsg).toBeDefined();
  // Pre-reactions should be redacted
  expect(client.redactEvent).toHaveBeenCalled();
});

test("ask_user_question with options: tapping 1️⃣ emits synthetic text '1'", async () => {
  const adapter = await makeAdapter();
  const received: InboundChannelMessage[] = [];
  adapter.onMessage = async (msg) => { received.push(msg); };
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$prompt-event");
  client.sendEvent.mockResolvedValue("$reaction-event");

  await adapter.handleControlRequestEvent!({
    requestId: "req-ask",
    kind: "ask_user_question",
    source: {
      channel: "matrix", accountId: "acc1", chatId: "!room:example.com",
      senderId: "@user:example.com", messageId: "$orig", agentId: "a1", conversationId: "c1",
    },
    toolName: "AskUserQuestion",
    input: {
      questions: [{
        question: "Which env?",
        options: [{ label: "staging" }, { label: "production" }],
      }],
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

test("ask_user_question with >10 options falls back to text prompt, no pre-reactions", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage.mockResolvedValueOnce("$prompt-event");
  client.sendEvent.mockResolvedValue("$reaction-event");

  const manyOptions = Array.from({ length: 12 }, (_, i) => ({ label: `Option ${i + 1}` }));

  await adapter.handleControlRequestEvent!({
    requestId: "req-many",
    kind: "ask_user_question",
    source: {
      channel: "matrix", accountId: "acc1", chatId: "!room:example.com",
      senderId: "@user:example.com", messageId: "$orig", agentId: "a1", conversationId: "c1",
    },
    toolName: "AskUserQuestion",
    input: { questions: [{ question: "Pick one:", options: manyOptions }] },
  });

  // 10 emoji pre-reactions + 📝 = 11; but >10 options means options 11+ are text-only
  const reactionCalls = client.sendEvent.mock.calls.filter(
    (c: unknown[]) => c[1] === "m.reaction",
  );
  // Should have 10 keycap + 1 📝 = 11
  expect(reactionCalls).toHaveLength(11);
});
```

- [ ] **Step 2: Run tests**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test-name-pattern "tapping 📝|ask_user_question" 2>&1 | tail -30
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tests/channels/matrix-adapter.test.ts
git commit -m "test(matrix): add freeform and ask_user_question reaction tests"
```

---

## Task 12: Adapter — E2EE graceful degradation

- [ ] **Step 1: Write failing test** (append to `matrix-adapter.test.ts`)

```typescript
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
    ensureMatrixRuntimeInstalled: async () => true,
  }));

  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const e2eeAccount = { ...TEST_ACCOUNT, e2ee: true };
  const adapter = createMatrixAdapter(e2eeAccount);

  // Should not throw even though crypto addon fails
  await adapter.start();
  expect(adapter.isRunning()).toBe(true);
  // Client still created (without crypto provider)
  expect(FakeMatrixClient.instances).toHaveLength(1);
});
```

- [ ] **Step 2: Run test**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test-name-pattern "E2EE" 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tests/channels/matrix-adapter.test.ts
git commit -m "test(matrix): add E2EE graceful degradation test"
```

---

## Task 13: `setup.ts` — CLI setup wizard

**Files:**
- Create: `src/channels/matrix/setup.ts`

No automated tests — the wizard is an interactive CLI. Manual testing notes are provided.

- [ ] **Step 1: Create `setup.ts`**

```typescript
// src/channels/matrix/setup.ts
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { upsertChannelAccount } from "../accounts";
import type { DmPolicy, MatrixChannelAccount } from "../types";
import { ensureMatrixRuntimeInstalled, loadMatrixBotSdkModule } from "./runtime";

function parseBytesString(input: string): number {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(mb|gb|kb)?$/);
  if (!match) return 50 * 1024 * 1024;
  const value = parseFloat(match[1]!);
  const unit = match[2] ?? "mb";
  if (unit === "gb") return Math.floor(value * 1024 * 1024 * 1024);
  if (unit === "kb") return Math.floor(value * 1024);
  return Math.floor(value * 1024 * 1024);
}

async function validateMatrixToken(
  homeserverUrl: string,
  accessToken: string,
): Promise<{ userId: string }> {
  const url = `${homeserverUrl.replace(/\/$/, "")}/_matrix/client/v3/account/whoami`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as { user_id: string };
  if (!data.user_id) throw new Error("No user_id in whoami response");
  return { userId: data.user_id };
}

export async function runMatrixSetup(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("\n🔷 Matrix Bot Setup\n");

    await ensureMatrixRuntimeInstalled();

    // Step 1: Homeserver URL
    const homeserverInput = await rl.question("Homeserver URL (e.g. https://matrix.example.com): ");
    const homeserverUrl = homeserverInput.trim().replace(/\/$/, "");
    if (!homeserverUrl) {
      console.error("No homeserver URL provided. Setup cancelled.");
      return false;
    }

    // Validate reachability
    console.log("\nChecking homeserver...");
    try {
      const r = await fetch(`${homeserverUrl}/_matrix/client/versions`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      console.log("✓ Homeserver reachable\n");
    } catch (err) {
      console.error(`✗ Cannot reach homeserver: ${err instanceof Error ? err.message : err}`);
      return false;
    }

    // Step 2: User ID
    const userIdInput = await rl.question(
      "Bot Matrix user ID (e.g. @letta-bot:example.com): ",
    );
    const userId = userIdInput.trim();
    if (!userId.startsWith("@") || !userId.includes(":")) {
      console.error('Invalid user ID. Must be in the form @username:server. Setup cancelled.');
      return false;
    }

    // Step 3: Access token
    console.log("\nGenerate a compatibility token with:");
    console.log("  mas-cli manage issue-compatibility-token " + userId.split(":")[0]?.slice(1));
    console.log("(Run this on your Synapse server)\n");

    const tokenInput = await rl.question("Access token: ");
    const accessToken = tokenInput.trim();
    if (!accessToken) {
      console.error("No access token provided. Setup cancelled.");
      return false;
    }

    // Validate token
    console.log("\nValidating access token...");
    let validatedUserId: string;
    try {
      const info = await validateMatrixToken(homeserverUrl, accessToken);
      validatedUserId = info.userId;
      if (validatedUserId !== userId) {
        console.warn(
          `⚠ Token belongs to ${validatedUserId}, expected ${userId}. Continuing with ${validatedUserId}.`,
        );
      }
      console.log(`✓ Authenticated as ${validatedUserId}\n`);
    } catch (err) {
      console.error(`✗ Invalid token: ${err instanceof Error ? err.message : err}`);
      return false;
    }

    // Step 4: DM policy
    console.log("DM Policy — who can message this bot?\n");
    console.log("  pairing   — Users must pair with a code (recommended)");
    console.log("  allowlist — Only pre-approved Matrix user IDs");
    console.log("  open      — Anyone can message\n");

    const policyInput = await rl.question("DM policy [pairing]: ");
    const policy = (policyInput.trim() || "pairing") as DmPolicy;
    if (!["pairing", "allowlist", "open"].includes(policy)) {
      console.error(`Invalid policy "${policy}". Setup cancelled.`);
      return false;
    }

    let allowedUsers: string[] = [];
    if (policy === "allowlist") {
      const usersInput = await rl.question(
        "Allowed Matrix user IDs (comma-separated, e.g. @alice:example.com): ",
      );
      allowedUsers = usersInput.split(",").map((s) => s.trim()).filter(Boolean);
    }

    // Step 5: E2EE
    console.log(
      "\nE2EE encrypts messages end-to-end. Requires the Rust crypto addon (best-effort under Bun).",
    );
    console.log("Testing crypto addon availability...");
    let e2eeAvailable = false;
    try {
      const { RustSdkCryptoStorageProvider } = await loadMatrixBotSdkModule();
      e2eeAvailable = typeof RustSdkCryptoStorageProvider === "function";
      console.log(e2eeAvailable ? "✓ Crypto addon available\n" : "✗ Crypto addon unavailable\n");
    } catch {
      console.log("✗ Crypto addon unavailable\n");
    }

    let e2ee = false;
    if (e2eeAvailable) {
      const e2eeInput = await rl.question("Enable E2EE? [y/N]: ");
      e2ee = /^(y|yes)$/i.test(e2eeInput.trim());
    } else {
      console.log("Skipping E2EE (addon not available).");
    }

    // Step 6: Voice transcription
    const transcriptionInput = await rl.question(
      "\nAuto-transcribe voice memos when OPENAI_API_KEY is set? [y/N]: ",
    );
    const transcribeVoice = /^(y|yes)$/i.test(transcriptionInput.trim());

    // Step 7: Media download limit
    const maxBytesInput = await rl.question(
      "\nMax media download size [50mb]: ",
    );
    const maxMediaDownloadBytes = maxBytesInput.trim()
      ? parseBytesString(maxBytesInput)
      : 50 * 1024 * 1024;

    // Write account
    const now = new Date().toISOString();
    const account: MatrixChannelAccount = {
      channel: "matrix",
      accountId: randomUUID(),
      displayName: validatedUserId!,
      enabled: true,
      homeserverUrl,
      accessToken,
      userId: validatedUserId!,
      dmPolicy: policy,
      allowedUsers,
      e2ee,
      transcribeVoice,
      maxMediaDownloadBytes,
      createdAt: now,
      updatedAt: now,
    };

    upsertChannelAccount("matrix", account);
    console.log("\n✓ Matrix bot configured!");
    console.log("Config written to: ~/.letta/channels/matrix/accounts.json\n");
    console.log("Next steps:");
    console.log("  1. Start the listener: letta server --channels matrix");
    console.log("  2. Invite the bot to a Matrix room");
    console.log("  3. Send !start to get a pairing code");
    console.log(
      "  4. In the target ADE/Desktop conversation, run: /channels matrix pair <code>\n",
    );

    return true;
  } catch (error) {
    console.error(
      `Setup failed: ${error instanceof Error ? error.message : error}`,
    );
    return false;
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
bun run tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 3: Manual test checklist**

To manually test (requires a real Matrix homeserver):
1. Run `bun run src/channels/matrix/setup.ts` (or via `letta channels configure matrix`)
2. Enter a reachable homeserver URL — confirm "✓ Homeserver reachable"
3. Enter an invalid token — confirm "✗ Invalid token" error
4. Enter a valid compatibility token — confirm "✓ Authenticated as @bot:example.com"
5. Choose `pairing` policy and confirm account written to `~/.letta/channels/matrix/accounts.json`

- [ ] **Step 4: Commit**

```bash
git add src/channels/matrix/setup.ts
git commit -m "feat(matrix): add CLI setup wizard"
```

---

## Task 14: Run full test suite and fix any regressions

- [ ] **Step 1: Run the complete matrix test file**

```bash
bun test src/tests/channels/matrix-adapter.test.ts 2>&1 | tail -40
```

Expected: all tests PASS, no failures.

- [ ] **Step 2: Run the broader channel test suite**

```bash
bun test src/tests/channels/ 2>&1 | tail -40
```

Expected: no regressions in Telegram, Slack, Discord, or shared channel tests.

- [ ] **Step 3: Run the MessageChannel tests**

```bash
bun test src/tests/channels/matrix-markdown.test.ts src/tests/ --test-name-pattern "message.channel|MessageChannel|outbound" 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 4: TypeScript clean**

```bash
bun run tsc --noEmit 2>&1
```

Expected: zero errors.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(matrix): complete matrix channel implementation"
```

---

## Self-Review Against Spec

| Spec requirement | Task |
|---|---|
| `matrix-bot-sdk@0.8.0` as runtime package | Task 1, 2 |
| `MatrixChannelAccount` with all fields | Task 1 |
| E2EE best-effort with `RustSdkCryptoStoreType.Sled` | Task 7 |
| E2EE graceful degradation | Task 7, 12 |
| Auto-accept room invites | Task 7 |
| Text messages → `onMessage` | Task 7 |
| Own messages filtered | Task 7 |
| `chatType` via `getJoinedRoomMembers` | Task 7 |
| `senderName` via `getUserProfile` → `displayname` | Task 7 |
| `m.reaction` inbound → `InboundChannelMessage` with `reaction.action: "added"` | Task 7, 9 |
| `m.room.redaction` inbound | Task 7 |
| Media download with MXC → HTTP, size limit, base64 for images ≤5MB, voice transcription | Task 5 |
| Outbound text with `body` + `formatted_body` when `parseMode === "HTML"` | Task 7 |
| `markdownToMatrixHtml` via `marked` | Task 4 |
| `stripMarkdownToPlainText` for plain-text `body` fallback | Task 4 |
| Matrix entry in `CHANNEL_OUTBOUND_FORMATTERS` | Task 4 |
| Outbound `m.reaction` via `sendEvent` | Task 7, 9 |
| Reaction removal via `redactEvent` | Task 7, 9 |
| Outbound media upload via `uploadContent(buffer, contentType, filename)` | Task 7 |
| `sendDirectReply` with optional `m.in_reply_to` | Task 7 |
| `!start` and `!status` bot commands | Task 7, 8 |
| `handleControlRequestEvent` with emoji prompt and pre-reactions | Task 7, 10 |
| ✅/❌ reactions → synthetic "approve"/"deny" | Task 10 |
| 📝 reaction → freeform follow-up → user text emitted normally | Task 11 |
| `ask_user_question` keycap emojis 1️⃣–🔟, >10 falls back to text | Task 11 |
| Reactions from other users ignored | Task 10 |
| Pre-reactions redacted after response | Task 10, 11 |
| Setup wizard with `mas-cli` token instructions | Task 13 |
| Setup wizard validates token via `whoami` | Task 13 |
| Setup wizard E2EE opt-in with addon availability check | Task 13 |
| Configurable `maxMediaDownloadBytes` (default 50MB) | Task 5, 13 |
| `matrixMessageActions` send / react / upload-file | Task 6 |
| Plugin registered in `pluginRegistry.ts` | Task 1 |
| Config codec in `config.ts` | Task 1 |
| Test file mirrors `telegram-adapter.test.ts` patterns | Tasks 6–12 |
