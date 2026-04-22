# Matrix Channel Design

**Date:** 2026-04-22
**Status:** Approved

## Overview

Add a Matrix channel to letta-code with full feature parity with the Telegram channel. The bot connects as a regular Matrix user (Client-Server API) via `matrix-bot-sdk`, auto-accepts room invites, and uses the existing pairing/routing/DM-policy infrastructure unchanged. Control requests use a reaction-based pseudo-button UX — the Matrix-native equivalent of Telegram's inline keyboards.

---

## Architecture

Six files in `src/channels/matrix/`, mirroring the Telegram structure exactly:

| File | Purpose |
|---|---|
| `plugin.ts` | `matrixChannelPlugin` export; declares `matrix-bot-sdk@0.8.0` as the runtime package |
| `adapter.ts` | `createMatrixAdapter()` — lifecycle, sync loop, inbound/outbound, reaction handling |
| `media.ts` | MXC URL upload/download, MIME inference, attachment pipeline |
| `messageActions.ts` | `ChannelMessageActionAdapter` — send / react / upload-file actions |
| `runtime.ts` | Lazy-load `matrix-bot-sdk` from the separate per-channel runtime dir |
| `setup.ts` | CLI wizard: homeserver URL, access token, DM policy, E2EE opt-in |

Registration changes: `types.ts` (add `"matrix"` to `SUPPORTED_CHANNEL_IDS`, add `MatrixChannelAccount` type), `pluginRegistry.ts` (add `matrix` entry), `config.ts` (add codec).

The runtime package (`matrix-bot-sdk@0.8.0`) is installed on-demand into `~/.letta/channels/matrix/runtime/` by `runtime.ts` — the same pattern as grammy for Telegram.

---

## Connection & Authentication

**Homeserver target:** Synapse + Matrix Authentication Service (MAS).

**Bot auth:** MAS does not yet have a self-service bot auth flow. The setup wizard instructs the operator to issue a compatibility token via `mas-cli`:

```sh
mas-cli manage issue-compatibility-token <bot-username>
```

This produces a long-lived bearer token that works with the Matrix C-S API. The wizard accepts and stores this token as part of the `MatrixChannelAccount`.

**`MatrixChannelAccount` fields:**
- `homeserverUrl: string` — e.g. `https://matrix.example.com`
- `accessToken: string` — compatibility token from `mas-cli`
- `userId: string` — full Matrix user ID, e.g. `@letta-bot:example.com`
- `dmPolicy: "pairing" | "allowlist" | "open"`
- `allowedUserIds?: string[]` — used when `dmPolicy === "allowlist"`
- `e2ee: boolean` — whether to attempt E2EE (best-effort)
- `transcribeVoice?: boolean` — requires `OPENAI_API_KEY`
- `maxMediaDownloadBytes?: number` — max file size to download (default: 52_428_800 = 50 MB)

**Sync:** `matrix-bot-sdk` manages the sync loop internally via `MatrixClient.start()`. No manual long-polling needed.

---

## E2EE

E2EE is best-effort. During adapter startup:

```typescript
let cryptoProvider: RustSdkCryptoStorageProvider | undefined;
try {
  const { RustSdkCryptoStorageProvider, RustSdkCryptoStoreType } = await loadMatrixBotSdkModule();
  cryptoProvider = new RustSdkCryptoStorageProvider(cryptoStoragePath, RustSdkCryptoStoreType.Sled);
} catch (err) {
  log.warn("Matrix E2EE unavailable (Rust crypto addon failed to load); running unencrypted");
}
const client = new MatrixClient(homeserverUrl, accessToken, storageProvider, cryptoProvider);
```

The `RustSdkCryptoStorageProvider` wraps `@matrix-org/matrix-sdk-crypto-nodejs` (Rust OlmMachine bindings). Tested under Bun 1.3.9: all crypto operations work; a Tokio-runtime panic occurs only on process exit (Bun teardown quirk) and does not affect runtime correctness or storage integrity.

**Device identity:** On first start with an empty crypto store the SDK calls `whoami` to obtain the server-assigned `device_id` and persists it. On subsequent starts the stored `device_id` is reused — the bot is the same Matrix device across restarts. If the crypto store is lost or the access token changes, a new device is created and previously encrypted messages become undecryptable.

**Trust model:** The SDK has no TOFU, cross-signing, or device verification API. It encrypts outgoing messages for all known devices in a room without verification, and decrypts incoming messages transparently. In rooms where a user has "never send to unverified devices" enabled, the bot will be silently excluded from receiving room keys — messages in those rooms will fail to decrypt. This is an uncommon strict setting and is an accepted limitation of the best-effort stance.

Storage paths:
- `~/.letta/channels/matrix/<accountId>/storage.json` — bot sync state
- `~/.letta/channels/matrix/<accountId>/crypto/` — E2EE key store (if enabled)

---

## Inbound Events

### Room invites
The adapter registers a `room.invite` handler. All invites are auto-accepted via `client.joinRoom(roomId)`. DM policy enforcement happens upstream in the registry after the first message from that room arrives (same as Telegram).

### Text messages
`client.on("room.message", ...)` — filters out own messages (`event.sender === userId`). Extracts text from `m.text` or `m.notice` content. Constructs `InboundChannelMessage` with:
- `chatId`: Matrix room ID
- `senderId`: sender's Matrix user ID
- `senderName`: display name resolved via `client.getUserProfile(senderId)`
- `chatType`: `"direct"` for 1:1 rooms, `"channel"` for multi-user rooms. Detected via `await client.getJoinedRoomMembers(roomId)` — length of 2 means a DM. (`client.dms.isDm()` is account-data based and unreliable for rooms initiated by other parties.)
- `messageId`: Matrix event ID

### Reactions
`client.on("room.event", ...)` filtered to `m.reaction` type. Extracts `relates_to.key` (emoji) and `relates_to.event_id` (target message ID).

**Control-request reactions** are intercepted before reaching the registry (see Control Requests section). All other reactions are emitted as `InboundChannelMessage` with `reaction: { action: "add", emoji, targetMessageId }` — matching the Telegram pattern.

Reaction removal: listen via `room.event` filtered to `event['type'] === 'm.room.redaction'`. The redacted event ID is in `event['redacts']` (top-level field). The adapter looks up `event['redacts']` in its `sentReactionEventIds` maps to determine if a pre-reaction was removed, then emits `reaction: { action: "remove", emoji, targetMessageId }`.

### Media / attachments
Handled for `m.image`, `m.video`, `m.audio`, `m.file` content types. Download pipeline:
1. Resolve MXC URL → authenticated download URL via `client.mxcToHttp(mxcUrl)` (or `client.mxcToHttpThumbnail` for images)
2. Enforce download size limit (skip with warning if `info.size` exceeds `account.maxMediaDownloadBytes ?? 52_428_800`)
3. Download to `~/.letta/channels/matrix/inbound/<accountId>/<timestamp>-<uuid>-<filename>`
4. Images ≤ 5 MB get `imageDataBase64` populated for vision model use
5. Voice messages (`m.audio` with `voice: true`): transcribed via OpenAI Whisper if `transcribeVoice` is enabled and `OPENAI_API_KEY` is set

---

## Outbound Messages

### Text
A `"matrix"` entry is added to `CHANNEL_OUTBOUND_FORMATTERS` in `src/tools/impl/MessageChannel.ts`. It calls `markdownToMatrixHtml(text)` (using `marked` for Markdown → HTML conversion) and returns `{ text: strippedPlainText, parseMode: "HTML" }`. The plain-text value strips Markdown syntax so clients that ignore `formatted_body` don't show raw `**bold**` etc.

The adapter checks `msg.parseMode`:
- **Set (`"HTML"`):** `client.sendMessage(roomId, { msgtype: "m.text", body: msg.text, format: "org.matrix.custom.html", formatted_body: htmlFromParseMode })`
- **Not set:** `client.sendMessage(roomId, { msgtype: "m.text", body: msg.text })`

The `body` field is always the plain-text fallback as required by the Matrix spec.

### Media upload
`client.uploadContent(buffer, contentType, filename)` returns an MXC URL (positional args — not an options object). Then:
- Images → `m.image`
- Video → `m.video`
- Audio → `m.audio`
- Everything else → `m.file`

`caption` is sent as the `body` field of the media event.

### Reactions
`client.sendEvent(roomId, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: targetEventId, key: emoji } })`

Reaction removal: `client.redactEvent(roomId, reactionEventId)`.

The adapter tracks `sentReactionEventIds: Map<string, string>` (emoji → reactionEventId) per pending control request message, so reactions can be redacted after the user responds.

### Direct replies
`client.sendMessage(roomId, { msgtype: "m.text", body, "m.relates_to": { "m.in_reply_to": { event_id: replyToEventId } } })`

`sendDirectReply(chatId, text, options?)` — used by the registry for pairing codes, DM policy rejections, and reprompts. Calls `client.sendMessage` with plain text, optionally with `m.in_reply_to` if `replyToMessageId` is provided.

---

## Control Requests (Reaction-Based UI)

### Emoji assignments by kind

| Kind | Reactions |
|---|---|
| `generic_tool_approval` | ✅ approve · ❌ deny · 📝 deny with reason |
| `enter_plan_mode` | ✅ approve · ❌ deny |
| `exit_plan_mode` | ✅ approve · 📝 provide feedback |
| `ask_user_question` | 1️⃣–🔟 for first 10 options · 📝 freeform answer |

`ask_user_question` options are unconstrained in the spec. Keycap emojis cover up to 10 options (1️⃣–9️⃣ + 🔟). If there are more than 10 options, the excess are rendered in the prompt text only — no pre-reactions for those; the user must type their answer. In practice questions with >10 options should not occur.

If `ask_user_question` has zero options (pure freeform), no pre-reactions are sent. The prompt text instructs the user to type their answer directly; the next plain text message from that sender is emitted as the response.

### Message format example (`ask_user_question`)
```
Which environment should I deploy to?
  1️⃣  staging
  2️⃣  production
  3️⃣  cancel
  📝  type a custom answer
```
Bot pre-reacts with 1️⃣, 2️⃣, 3️⃣, 📝.

### Handling flow

`handleControlRequestEvent(event)`:
1. Build and send the formatted prompt message (replying to `event.source.threadId ?? event.source.messageId`)
2. Record `sentMessageEventId` from the response
3. Pre-react with all applicable emojis on that event ID; record each reaction's event ID in `sentReactionEventIds`
4. Register entry in `pendingReactionRequests: Map<eventId, PendingReactionRequest>` with `{ requestId, kind, options, chatId, senderId, awaitingFreeform: false }`

Inbound reaction handler (before registry pipeline):
1. If `targetMessageId` not in `pendingReactionRequests` → pass through as a normal reaction event
2. If reaction sender ≠ the original `source.senderId` → ignore (another user's reaction)
3. Map emoji to response text:
   - ✅ → emit synthetic `InboundChannelMessage` with `text: "approve"`
   - ❌ → emit synthetic `InboundChannelMessage` with `text: "deny"`
   - 1️⃣–🔟 → emit synthetic with `text: "1"` … `"10"`
   - 📝 → do NOT emit; instead: send a follow-up prompt ("Please type your reason:" / "Please type your answer:"), set `awaitingFreeform: true` on the pending entry
4. After emitting (non-📝 path): redact all `sentReactionEventIds` for that request, remove from `pendingReactionRequests`

Inbound text message handler (before registry pipeline):
1. Check `awaitingFreeformByChat: Map<chatId, senderId>` — if this sender in this chat is awaiting freeform:
   - Remove from `awaitingFreeformByChat`
   - Redact the pre-reactions for that request
   - Remove from `pendingReactionRequests`
   - Emit synthetic `InboundChannelMessage` with the raw text (registry parses it as freeform deny reason or question answer)
2. Otherwise pass through normally

Synthetic `InboundChannelMessage` events use the same `chatId`, `senderId`, `accountId` as the original source so the registry's scope-key lookup matches the pending control request correctly.

---

## Setup Wizard (`runMatrixSetup`)

1. Ensure `matrix-bot-sdk` runtime is installed (`ensureMatrixRuntimeInstalled`)
2. Prompt for homeserver URL (validate reachability via `/_matrix/client/versions`)
3. Prompt for bot user ID (e.g. `@letta-bot:example.com`)
4. Prompt for access token — display instructions for generating via `mas-cli manage issue-compatibility-token <username>`
5. Validate token by calling `GET /_matrix/client/v3/account/whoami` and confirming the returned `user_id` matches
6. Prompt for DM policy (`pairing` / `allowlist` / `open`)
7. If `allowlist`: prompt for comma-separated Matrix user IDs
8. Prompt for E2EE opt-in (explain best-effort caveat if Rust addon status is unknown; test-load the addon and report result)
9. Prompt for voice transcription opt-in (requires `OPENAI_API_KEY`)
10. Prompt for max media download size (default: 50 MB; accepts human-readable values like `100mb`)
11. Write `MatrixChannelAccount` via `upsertChannelAccount`

---

## Bot Commands

| Command | Response |
|---|---|
| `!start` | Welcome message + pairing instructions |
| `!status` | Bot user ID and DM policy |

Matrix has no native `/command` bot API (unlike Telegram), so commands are plain text prefixed with `!`. The text handler checks for a leading `!` before passing messages to the registry pipeline.

---

## Error Handling

- **Token invalid / expired:** `start()` catches the 401 from `client.start()` and throws with a clear message directing the operator to reissue a compatibility token.
- **Homeserver unreachable:** `matrix-bot-sdk` handles transient sync failures internally with exponential backoff and no emitted event. Persistent failures (e.g. homeserver down for extended period) are caught by wrapping `client.start()` in a try/catch. A custom `ILogger` implementation can be injected via `LogService.setLogger()` to surface sync errors to the letta log system.
- **Crypto addon failure:** logged as a warning; adapter continues unencrypted.
- **Media download failure (size limit, timeout):** attachment is skipped with a warning; the message is still emitted with whatever text is present.
- **Reaction to non-existent pending request:** silently ignored.

---

## Testing

Pattern mirrors `src/tests/channels/telegram-adapter.test.ts`:

- `mock.module("../../channels/matrix/runtime", ...)` replaces `matrix-bot-sdk` with a `FakeMatrixClient` class that exposes handler maps and `emit(eventType, payload)` for triggering events in tests.
- Temp filesystem via `mkdtempSync` for storage paths; cleaned up in `afterEach`.
- Tests cover: startup sequencing, `sendMessage` (text, media, reply), reactions (send, remove), control-request reaction flow (approve, deny, freeform), `ask_user_question` numbered options, >10 options fallback, E2EE graceful degradation, voice transcription opt-in/off.

Test file: `src/tests/channels/matrix-adapter.test.ts`
