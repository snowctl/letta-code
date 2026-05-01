# Matrix Adapter Refactor — Design

**Date:** 2026-05-01
**Status:** Approved for planning
**Scope:** `src/channels/matrix/`

## Problem

`src/channels/matrix/adapter.ts` has grown to 2385 lines as Matrix-specific UX
features have accumulated: thinking placeholders, live tool progress, tool
blocks, streaming previews, completion footers, segment-by-segment streaming.
Each addition added more state Maps keyed by `chatId` (~12 today) and more
ad-hoc cross-handler synchronization (`__pending__` sentinels, polling waits,
serialized promise chains). The result is convoluted, error-prone, and has
produced a string of regressions visible in recent commits (`4aedddf0`,
`391393bd`, `9a99f9e8`, `9ccc41ad`).

### Reported issues this design addresses

1. **Tool block sometimes renders after the assistant message.** The streaming
   path doesn't drain pending tool-block edits before posting. Caused by
   `handleStreamText` not awaiting `toolBlockOperationByChatId`.
2. **Random leading space on edited assistant messages.** The `* ` edit-fallback
   prefix is being injected into `formatted_body` (HTML), not just the plain
   `body`. Element strips the asterisk and leaves the space. Sources:
   `adapter.ts:1314` (messageActions edit) and `adapter.ts:1804` (completion
   footer fallback).
3. **Streaming feels slow.** 500ms throttle floor, no leading-edge edit when
   the initial post resolves.
5. **Streaming breaks formatting until the final response.** `handleStreamText`
   sends raw text with no `format: "org.matrix.custom.html"`; only the final
   replace renders markdown.
6. **Tool execution timer renders inside the thinking block, disappears after
   completion.** Per-tool durations should persist next to the tool that ran.

(Issue #4 — inbound delay — is split out to a separate Forgejo ticket. Inbound
code paths are lifted-and-shifted with no behavior change so the bisect target
is preserved.)

### Empty-thinking-block bug

Today's adapter posts bare "Thinking…" placeholders that are never filled, in
two cases:

- `ensureThinkingPlaceholder` at `tool_started` (`adapter.ts:1583–1587`)
- `scheduleToolBlockUpdate`'s pre-creation block (`adapter.ts:898–919`)

Both exist to host the running-tool live timer, or to enforce ordering above
the tool block. Neither is necessary once tool timing moves to the tool block
and ordering is handled by the turn coordinator.

## Goals

- Fix issues #1, #2, #3, #5, #6 and the empty-thinking-block bug.
- Split `adapter.ts` into focused modules with explicit per-chat state ownership.
- Eliminate the class of ordering bugs that #1 belongs to, by construction.
- No changes to `ChannelAdapter` interface — Telegram and other adapters are
  untouched.
- No new dependencies. Reuse `marked` for streaming markdown.

## Non-goals

- Issue #4 (inbound 5–10s delay) — separate ticket.
- E2EE, cross-signing, undici dispatcher, media handling, control-request flow
  — all preserved as-is (lifted to dedicated modules with no behavior change).
- Changes to `messageActions.ts` (the channel-tool action surface).

## Architecture

### Module split

`src/channels/matrix/adapter.ts` becomes a thin wiring layer (~400 lines).

```
src/channels/matrix/
  adapter.ts                 — ChannelAdapter wiring; delegates to ChatTurn
  client.ts                  — createClient, undici dispatcher, request shim
  htmlFormat.ts              — markdownToMatrixHtml, htmlTableToAscii, escapeHtml,
                               redactSecrets, buildArgsPreview, formatElapsed,
                               formatCompact, clipReasoningForMatrix,
                               StreamingFormatter (streaming-safe markdown)
  matrixSender.ts            — MatrixSender { sendNew, edit, sendReaction,
                               redact }: single source of truth for m.replace
                               envelopes
  inbound.ts                 — room.message + room.event handlers,
                               RoomMembersCache, attachment processing
  botCommands.ts             — !cmd handling, dispatchOperatorCommand
  controlRequests.ts         — handleControlRequestEvent + reaction/redaction
  turn/
    ChatTurn.ts              — per-chat turn coordinator
    ChatTurnRegistry.ts      — chatId → ChatTurn map
    ThinkingBlock.ts         — reasoning placeholder (text-only after refactor)
    ToolBlock.ts             — tool list with per-tool timing
    StreamingMessage.ts      — stream segment preview
```

Existing files unchanged: `crossSigning.ts`, `media.ts`, `messageActions.ts`,
`plugin.ts`, `runtime.ts`, `setup.ts`.

### Why turn-object architecture

A turn is implicitly a state machine: `queued → processing → (reasoning |
tool_call | stream_text)* → finished`. Today no module owns the machine;
each handler reaches into 12 Maps and races with the others through the
gaps. The turn-object pattern models a turn as an object whose fields are
the three rendered "blocks" (thinking, tool, current stream segment). Methods
on the turn correspond to lifecycle signals; ordering between blocks is
enforced inside the turn rather than at every call site.

This is the structural fix that makes issue #1 stop being a class of bug.

### `MatrixSender`

```ts
class MatrixSender {
  constructor(private client: MatrixClientLike) {}

  async sendNew(roomId: string, content: {
    text: string;
    html?: string;
    replyToMessageId?: string;
  }): Promise<string>;

  async edit(roomId: string, eventId: string, content: {
    text: string;
    html?: string;
  }): Promise<void>;

  async sendReaction(roomId: string, targetEventId: string,
    emoji: string): Promise<string>;

  async redact(roomId: string, eventId: string): Promise<void>;
}
```

Single helper that owns the m.replace envelope shape. The `* ` fallback
prefix is applied to plaintext `body` only, never to `formatted_body` —
fixes issue #2 by construction. Every existing edit/send call site collapses
to one of these four methods.

### Block interface

```ts
interface MatrixBlock {
  /** Resolves with the eventId once the initial post has landed. */
  readonly posted: Promise<string>;

  /** Apply final content (e.g. footer) and stop further updates. */
  finalize(content?: { text: string; html: string }): Promise<void>;
}
```

Each block owns its own throttle/debounce. Update calls (`appendChunk`,
`onChunk`, `onToolStart`, etc.) are fire-and-forget; the block coalesces
edits internally.

### `ThinkingBlock`

Reasoning text only. No tool progress, no live tool timer. Constructed only
on the first `onReasoningChunk` — eliminates empty-thinking-block bug.

```ts
class ThinkingBlock implements MatrixBlock {
  readonly posted: Promise<string>;
  appendChunk(chunk: string): void;        // word-spacer + tool-separator handling
  markToolInterruption(): void;            // next chunk gets "\n--\n" prefix
  async finalize(footer?: Footer): Promise<void>;
}
```

- Posts `"Thinking..."` immediately on construction.
- Flush interval edits placeholder at 150ms cadence with sliding-window
  64KiB-clipped buffer, **word-boundary aligned** (issue #3).
- Streaming-safe HTML rendering via `StreamingFormatter` (issue #5).
- Dedupes identical content.
- `finalize` edits to `<b>Thinking</b><br><blockquote>…</blockquote>` with
  optional footer (`<hr>✓ completed in m:ss · X / Y tokens`).

### `ToolBlock`

```ts
interface ToolEntry {
  toolCallId: string;
  toolName: string;
  description?: string;
  startedAt: number;
  endedAt?: number;
  outcome?: "success" | "error";
}

class ToolBlock implements MatrixBlock {
  readonly posted: Promise<string>;
  onToolStart(call): void;
  onToolEnd(toolCallId: string, outcome: "success" | "error"): void;
  async finalize(): Promise<void>;
}
```

**Rendered shape:**

```
🔧 Tools used:
Read — src/channels/matrix/adapter.ts
Bash — Run test suite (2m52s)
```

- Live timer for entries that have been running ≥1s; before that, no duration
  is shown (avoids `(0:00)` flicker for fast tools).
- Per-entry 1-second timer, scheduled on `onToolStart`. If `onToolEnd`
  arrives first, the timer is cancelled and the entry's final render decides
  duration visibility.
- 5-second ticker re-renders the block while any entry is still running past
  the 1s threshold. Stops automatically when the last running entry ends.
- All tool calls appear in the block (record of what ran), even fast ones.
- Sub-1s completed tools render as `Read — src/foo.ts` with no parenthesized
  duration. Errored tools as `Bash — desc (errored after 1m04s)` or
  `(errored)` for sub-1s errors.
- Operation chain serializes edits — every `onToolStart`/`onToolEnd`
  schedules a single coalesced edit.
- `ChannelAction` and `NotifyUser` are excluded (today's behavior preserved).

### `StreamingMessage`

```ts
class StreamingMessage implements MatrixBlock {
  readonly posted: Promise<string>;
  onChunk(accumulatedText: string): void;
  async replaceWithFinal(content: { text: string; html: string }): Promise<string>;
  dispose(): void;
}
```

Represents **one stream segment**, not "the message for the turn." Per turn,
the assistant produces a sequence of messages in the timeline:

```
[stream segment 1] → [tool call] → [stream segment 2] → [explicit ChannelAction] → [final stream segment]
```

`handleStreamReset` (existing, recently added in `391393bd`) marks segment
boundaries: when a tool call fires mid-stream, the current segment is closed
and the next chunk starts a fresh segment.

- Lazy first post on first `onChunk`.
- Throttle floor 500ms → **250ms** (issue #3).
- Word-boundary aligned flushes (issue #3): on flush, truncate to last `\s` in
  buffer; if no growth past last flushed boundary, skip.
- Streaming-safe HTML via `StreamingFormatter` (issue #5).
- Leading-edge edit when `__pending__` resolves (preserved from today).
- M_LIMIT_EXCEEDED backoff doubles `currentInterval` up to 8s (preserved).
- `dispose()` cancels pending timers without sending.

### `ChatTurn` coordinator

```ts
class ChatTurn {
  private thinking: ThinkingBlock | null = null;
  private toolBlock: ToolBlock | null = null;
  private currentStream: StreamingMessage | null = null;
  private lastResponse: { eventId, text, html } | null = null;
  private pendingResponseText: string | null = null;
  private startedAt: number = Date.now();

  // Lifecycle delegates
  onQueued(): void;
  onProcessing(): void;
  async onReasoningChunk(text: string): Promise<void>;
  onToolStart(call): void;
  onToolEnd(call, durationMs, outcome): void;
  onToolCallScheduled(toolName, description?): void;
  async onStreamText(accumulatedText: string): Promise<void>;
  async onStreamReset(): Promise<void>;
  setPendingResponseText(text: string): void;

  // Terminal paths
  async finish(event): Promise<void>;
  async sendOutbound(msg: OutboundChannelMessage): Promise<{ messageId: string }>;
}
```

#### Segment lifecycle inside `ChatTurn`

| Event | Action |
|---|---|
| First stream chunk | Lazy-create `currentStream`, chunk it |
| Subsequent chunks | `currentStream.onChunk(text)` |
| `onStreamReset` (tool interruption) | `currentStream.replaceWithFinal({text, html})` to lock segment as formatted HTML; update `lastResponse`; set `currentStream = null` |
| Next chunk after tool | New `StreamingMessage`, fresh Matrix message in timeline |
| Explicit `sendOutbound` (ChannelAction / NotifyUser) | If `currentStream` exists: replace it with explicit text. Else: `sender.sendNew`. Update `lastResponse`. |
| `finish(completed)` with `pendingText` | If `currentStream`: `replaceWithFinal(pendingText + footer)`. Else: `sendNew(pendingText + footer)`. |
| `finish(completed)` no `pendingText` | Edit `lastResponse` to append footer (today's fallback path). |
| `finish(error)` | Finalize `currentStream` with no footer; thinking block gets error footer. |
| `finish(cancelled)` | Finalize `currentStream` with no footer; thinking block gets cancellation footer. |

#### `finish()` — the path that fixes issue #1

```ts
async finish(event) {
  this.stopTyping();
  await this.toolBlock?.finalize();   // drain BEFORE final response
  const footer = this.buildFooter(event);

  if (event.outcome === "completed")  await this.commitFinalResponse(footer);
  else if (event.outcome === "error") await this.handleError(event, footer);
  else                                 await this.handleCancelled(footer);

  await this.thinking?.finalize(this.outcomeFooterForThinking(event));

  this.currentStream?.dispose();
  this.currentStream = null;
}
```

#### `sendOutbound()`

Replaces today's `adapter.sendMessage` plain-text branch. Drains
`toolBlock.posted` before sending so ChannelAction emissions can't beat a
still-pending tool block to the timeline.

### `ChatTurnRegistry`

```ts
class ChatTurnRegistry {
  getOrCreate(chatId: string): ChatTurn;
  get(chatId: string): ChatTurn | undefined;
  delete(chatId: string): void;
  disposeAll(): void;
}
```

Lazy creation; deletion happens at the end of `ChatTurn.finish()`.
`disposeAll()` is called from `adapter.stop()` and replaces today's 20-line
cleanup loop.

## Streaming details

### Word-aligned flush algorithm

```ts
flush() {
  const text = this.latestText;
  if (text === this.lastFlushedText) return;

  // Truncate to last word boundary; if no whitespace yet, send full text.
  const lastSpace = text.lastIndexOf(/\s/);
  const flushable = lastSpace > 0 ? text.slice(0, lastSpace) : text;
  if (flushable === this.lastFlushedText) return;     // no growth past boundary

  await this.sender.edit(this.chatId, this.eventId, this.formatter(flushable));
  this.lastFlushedText = flushable;
  this.lastEditAt = Date.now();
}
```

Same event rate as today (`MATRIX_STREAM_INTERVAL_MS` floor enforces it). May
*reduce* event count when text grows entirely within an unfinished word.
Synapse `rc_message` defaults are not exceeded.

### `StreamingFormatter`

Helper in `htmlFormat.ts` that pre-processes partial markdown text before
running `marked.parse`:

```ts
function streamingMarkdownToHtml(partial: string): { text: string; html: string } {
  let safe = partial;
  safe = closeUnclosedFences(safe);              // ``` and `
  safe = closeUnclosedEmphasis(safe);            // *, _, **, __
  safe = stripTrailingPartialLink(safe);         // [foo](http
  safe = stripTrailingPartialTag(safe);          // <ta
  return markdownToMatrixHtml(safe);
}
```

Each helper is a small string scan with explicit unit tests for each shape.
The formatter is used by both `ThinkingBlock` (when emitting reasoning HTML)
and `StreamingMessage`.

## Per-issue resolution

| Issue | Resolution |
|---|---|
| #1 Tool block lands after assistant message | `ChatTurn.finish()` and `sendOutbound()` `await this.toolBlock?.finalize()` / `posted` before committing the final response. Becomes structurally impossible to forget. |
| #2 Leading space on edits | `MatrixSender.edit()` is the single edit primitive. `* ` prefix is applied to plaintext `body` only, never to `formatted_body`. |
| #3 Streaming feels slow | Throttle floor 500ms → 250ms; word-boundary alignment; leading-edge edit on initial post resolution (preserved). |
| #5 Streaming breaks formatting | `StreamingFormatter` renders streaming-safe markdown→HTML. Live previews are formatted from the first chunk. |
| #6 Tool timer in thinking block | Per-tool timing moves to `ToolBlock`. Format `Tool — desc (m:ss)` while running, `Tool — desc (final)` after. Live timer only after 1s. |
| Empty thinking blocks | `ThinkingBlock` constructed lazily only on first `onReasoningChunk`. `ensureThinkingPlaceholder` at tool_started and `scheduleToolBlockUpdate`'s pre-creation block both deleted. |

## Out of scope

- Issue #4 (5–10s inbound delay) — separate Forgejo ticket. The inbound module
  is a lift-and-shift with no behavior change so the regression bisect can
  proceed against a stable baseline.
- E2EE, cross-signing, undici dispatcher tuning, media downloads, voice
  transcription — all preserved.
- Changes to `messageActions.ts` channel-tool action surface.
- Changes to other adapters (Telegram, etc.).

## Commit plan

Atomic commits within a single bundled PR. Commits 1–4 are pure refactor
(no behavior change) and the existing test suite must pass unchanged.
Commits 5–9 introduce behavior changes covered by new unit tests. Commit
10 is final cleanup.

```
1. refactor(matrix): extract MatrixSender helper for send/edit primitives
2. refactor(matrix): extract htmlFormat module
3. refactor(matrix): extract client.ts (transport)
4. refactor(matrix): extract inbound.ts, botCommands.ts, controlRequests.ts
5. refactor(matrix): introduce ChatTurn + Registry + ThinkingBlock
                     (drops empty-thinking-block bug, fixes #2 via MatrixSender)
6. refactor(matrix): introduce ToolBlock with per-tool timing
                     (fixes #1 via toolBlock.finalize await; fixes #6)
7. refactor(matrix): introduce StreamingMessage with segment lifecycle
                     (drops handleTurnLifecycleEvent("finished") from ~220 to ~30 lines)
8. feat(matrix): word-aligned streaming + faster cadence (#3)
9. feat(matrix): streaming-safe markdown rendering (#5)
10. chore(matrix): delete legacy helpers + tighten types
```

### Test strategy

- **Commits 1–4:** existing `bun test src/channels/matrix/` must pass unchanged.
- **Commit 5:**
  - `ChatTurn` lifecycle (queued → reasoning → finish, with no tool calls)
  - `ThinkingBlock` flush dedup, sliding-window clip
  - `MatrixSender.edit()` envelope shape — assert `* ` only on plaintext body
- **Commit 6:**
  - `ToolBlock` ordering with concurrent tool starts/ends
  - Sub-1s tool: no `(0:00)` rendered
  - Errored tool: `(errored after Xs)` or `(errored)` for sub-1s
  - `ChatTurn.finish()` waits for `toolBlock.finalize()` before final send
- **Commit 7:**
  - Segment lifecycle: stream → reset → stream → finish places three messages
  - `commitFinalResponse` selects stream-replace / sendNew / lastResponse-edit
    correctly per state combination
- **Commits 8–9:**
  - `StreamingFormatter` table-driven tests for partial markdown shapes:
    unclosed fence, unclosed `**`, partial link, partial tag, mixed
  - Word-boundary alignment unit tests

### Estimated PR size

~1500 lines added, ~1800 deleted (net ~−300). `adapter.ts`: 2385 → ~400.

## Open questions

None.
