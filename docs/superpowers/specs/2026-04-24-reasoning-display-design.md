# Reasoning Display in Telegram & Matrix

**Date:** 2026-04-24
**Status:** Approved

## Overview

Surface the agent's reasoning (chain-of-thought) to users in Telegram and Matrix. Enabled by default with a per-adapter opt-out config flag. Each platform uses a UX suited to its native capabilities.

---

## UX Decisions

### Matrix

Single message per agent turn containing both reasoning and answer.

**Lifecycle of the message:**

1. When the first reasoning chunk arrives, send an initial message:
   ```html
   <details><summary>Thinking...</summary></details>
   ```
   Store the returned `messageId` as `pendingTurnMessageId`.

2. As further reasoning chunks arrive, edit the message at ~500ms intervals, accumulating text inside the `<details>` block.

3. When the agent's `MessageChannel` tool fires with the answer, do one final edit — the reasoning drawer collapses (summary becomes `"Thinking"`, no ellipsis), a `<hr>` divider is appended, then the answer text:
   ```html
   <details><summary>Thinking</summary>[full reasoning]</details>
   <hr>
   [answer text]
   ```
   Clear `pendingTurnMessageId`. Normal `sendMessage` is suppressed for this turn.

4. If no reasoning is produced (model doesn't emit reasoning tokens), `handleStreamReasoning` is never called, `pendingTurnMessageId` is never set, and `sendMessage` falls through to its normal implementation — answer arrives as a standalone message with no drawer.

### Telegram

Answer-first, reasoning on demand.

1. `handleStreamReasoning` accumulates all chunks into a `pendingReasoning` string. No messages are sent during reasoning.

2. When `sendMessage(answer)` is called, if `pendingReasoning` is non-empty, an inline keyboard button is appended to the answer message:
   ```
   [ 🧠 Show reasoning ]
   ```
   After the message is sent, the reasoning is stored in `reasoningByMessageId: Map<messageId, string>` and `pendingReasoning` is cleared.

3. When the user taps the button, the adapter looks up `reasoningByMessageId.get(messageId)`, sends the reasoning text as a reply to the original message, and answers the callback query to dismiss the loading spinner.

4. If no reasoning is produced, `pendingReasoning` is empty, `sendMessage` behaves exactly as today — no button appended.

5. If multiple `MessageChannel` calls occur in a single turn, each answer message gets its own button carrying the same turn-level reasoning.

---

## Architecture

### `ChannelAdapter` interface (`src/channels/types.ts`)

New optional hook:
```ts
handleStreamReasoning?(chunk: string): Promise<void>
```

New config flag (on the adapter config or shared channel config):
```ts
showReasoning?: boolean  // default: true
```

When `showReasoning` is `false`, `handleStreamReasoning` is a no-op and no reasoning UI is rendered on either platform.

### `ChannelRegistry` (`src/channels/registry.ts`)

New dispatcher method, mirroring the existing `dispatchStreamText`:
```ts
async dispatchStreamReasoning(chunk: string, sources: ChannelSource[]): Promise<void> {
  for (const source of sources) {
    const adapter = this.getAdapter(source.channel, source.accountId)
    await adapter.handleStreamReasoning?.(chunk)
  }
}
```

### Protocol / headless layer

Wherever `line.kind === "reasoning"` is currently discarded, call `registry.dispatchStreamReasoning(line.text, sources)` instead. The existing `dispatchStreamText` call is the reference point for placement.

### Throttling

Each adapter manages its own flush loop (~500ms interval), draining its accumulated reasoning buffer and firing an edit only when the buffer has changed since the last flush. This lives in the adapter, not the registry.

---

## Per-Adapter State

### Matrix adapter

```ts
pendingTurnMessageId: string | null
reasoningBuffer: string
flushInterval: Timer | null
```

### Telegram adapter

```ts
pendingReasoning: string
reasoningByMessageId: Map<number, string>
```

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Matrix edit fails mid-stream | Log and continue — next interval retries with latest buffer |
| Matrix final edit fails | Fall back to sending a new message with the complete content |
| Telegram callback query for unknown `messageId` | Answer the query silently (dismiss spinner), do nothing |
| Reasoning chunk arrives after `sendMessage` | Discard silently — turn ordering makes this unlikely in practice |

---

## Testing

- **Happy path (Matrix):** mock matrix-bot-sdk client, drive full lifecycle (`turn_start` → N reasoning chunks → `sendMessage`), assert correct sequence of `sendMessage` / `editMessage` calls and final message structure
- **Happy path (Telegram):** mock grammY bot, assert answer sent with inline keyboard, assert callback query handler sends reasoning as reply
- **No reasoning path (both):** `handleStreamReasoning` never called → no spurious messages, no buttons
- **`showReasoning: false` (both):** hooks are no-ops, answer message unchanged
