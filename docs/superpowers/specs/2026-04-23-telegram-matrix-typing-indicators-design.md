# Telegram & Matrix: Typing Indicators + Tool Call Block

**Date:** 2026-04-23
**Status:** Approved

## Overview

Add two pieces of visual feedback to the Telegram and Matrix channel adapters, consistent with the existing Slack/Discord lifecycle pattern:

1. **Typing indicator** — native platform typing signal shown while the agent is processing, including across multi-turn loops and tool calls
2. **Tool call block** — a single persistent message created on the first tool invocation, edited in-place as more tools run, grouped by tool name + description with ×N counts

Neither feature shows an outcome signal (no ✅/❌ on finish). The typing indicator simply disappears when the turn ends.

---

## 1. Lifecycle Event Extension

Add a new variant to `ChannelTurnLifecycleEvent` in `src/channels/types.ts`:

```typescript
| { type: "tool_call"; batchId: string; toolName: string; description?: string; sources: ChannelTurnSource[] }
```

`description` is the optional `args.description` field present on tools like Bash — it disambiguates repeated calls to the same tool with different intent.

**Dispatch point:** add `onToolCall?: (toolName: string, description?: string) => void` to the `executeTool()` options in `src/tools/manager.ts`. Call it just before the tool runs (alongside the existing pre-tool hook). In the turn/queue layer where `batchId` and `sources` are in scope, wire this callback up to:

```typescript
registry.dispatchTurnLifecycleEvent({
  type: "tool_call",
  batchId,
  toolName,
  description,
  sources,
});
```

**Slack and Discord:** their `handleTurnLifecycleEvent` implementations have no branch for `"tool_call"` and will silently ignore it — no changes required.

---

## 2. Typing Indicator

### API calls

| Platform | Start | Stop |
|----------|-------|------|
| Telegram | `bot.api.sendChatAction(chatId, "typing")` — expires after ~5s, must refresh | N/A — let it expire naturally |
| Matrix | `client.sendTyping(roomId, true, 8000)` — 8s timeout, refresh every 4s | `client.sendTyping(roomId, false)` |

### State

Each adapter instance holds:

```typescript
const typingIntervalByChatId = new Map<string, Timer>();
```

### Lifecycle mapping

| Event | Action |
|-------|--------|
| `"queued"` (`event.source`) | Start interval for `event.source.chatId` if not already running |
| `"processing"` (`event.sources[]`) | Ensure interval running for each source's `chatId` (handles batching edge cases) |
| `"tool_call"` (`event.sources[]`) | No-op — interval already running |
| `"finished"` (`event.sources[]`) | Clear and delete interval for each source's `chatId`; Matrix also calls `sendTyping(roomId, false)` |

Interval fires every **4 seconds**. If a `"queued"` fires for a chat that already has an interval (shouldn't occur normally), the existing interval is reused.

On adapter `stop()`, clear all intervals and stop all typing indicators.

---

## 3. Tool Call Block

### State

Each adapter instance holds:

```typescript
interface ToolCallGroup {
  key: string;   // `toolName` or `toolName\0description`
  label: string; // display text: "bash — Run tests" or "read_file"
  count: number;
}

interface ToolBlockState {
  messageId: string;
  groups: ToolCallGroup[];
  charCount: number; // Telegram only
}

const toolBlockStateByChatId = new Map<string, ToolBlockState>();
const toolBlockOperationByChatId = new Map<string, Promise<void>>();
```

`toolBlockOperationByChatId` serializes operations per chat — same pattern as `lifecycleOperationByMessageKey` in Slack/Discord — to prevent race conditions from parallel tool calls.

### Rendering

```typescript
function renderToolBlock(groups: ToolCallGroup[]): string {
  const lines = groups.map(g =>
    g.count === 1 ? `• ${g.label}` : `• ${g.label} ×${g.count}`
  );
  return `🔧 Tools used:\n${lines.join("\n")}`;
}
```

Example output:

```
🔧 Tools used:
• bash — List project files ×3
• bash — Run tests ×2
• bash
• read_file ×4
• glob ×2
```

### On `"tool_call"` event (per source chat)

Enqueue to the serialized chain for that `chatId`:

1. Find existing group by key (`toolName + "\0" + (description ?? "")`) or create a new one
2. Increment count
3. Render the block
4. **If no prior state:** send a new message, store `messageId` and `charCount`
5. **If prior state exists:** edit the existing message

**Telegram size guard:** if the rendered block exceeds **3,800 characters** (headroom below the 4,096-char limit), send a new message instead and update `messageId`. The old block stays unchanged in chat as a natural continuation break.

**Matrix:** no size guard — block grows indefinitely.

### On `"finished"` event

Delete `toolBlockStateByChatId` and `toolBlockOperationByChatId` entries for each source chat. The sent message remains visible in chat.

---

## 4. Files to Modify

| File | Change |
|------|--------|
| `src/channels/types.ts` | Add `"tool_call"` variant to `ChannelTurnLifecycleEvent` |
| `src/tools/manager.ts` | Add `onToolCall?` to `executeTool()` options; call it pre-execution |
| `src/websocket/listener/queue.ts` (or turn layer) | Wire `onToolCall` callback to dispatch lifecycle event with batchId + sources |
| `src/channels/telegram/adapter.ts` | Implement `handleTurnLifecycleEvent()` with typing intervals + tool block |
| `src/channels/matrix/adapter.ts` | Implement `handleTurnLifecycleEvent()` with typing intervals + tool block |

---

## 5. Parallel Tool Call Behaviour

Read-only tools (Read, Glob, Grep, WebSearch, etc.) and Task tools run in parallel via `Promise.all` (`approval-execution.ts:458`). Two parallel `"tool_call"` events for the same chat arrive nearly simultaneously. The serialized operation chain guarantees correctness:

1. Event for `read_file` arrives → enqueues: send new message with `• read_file`
2. Event for `glob` arrives ~1ms later → enqueues: edit message with `• read_file\n• glob` (waits for step 1)

For the same tool+description called in parallel (e.g. two concurrent `Read` calls), both enqueue independently. Count mutation happens inside the serialized closure so the second operation always sees the incremented state — no double-count risk.

---

## 6. Testing

- **`renderToolBlock()`**: grouping, deduplication, ×N formatting, label with/without description, tool ordering
- **Typing indicator**: starts on `"queued"`, survives `"tool_call"` events, stops on `"finished"`; Matrix sends explicit stop; Telegram lets expire
- **Tool block — create**: first `"tool_call"` sends a new message
- **Tool block — edit**: subsequent `"tool_call"` events edit in place
- **Tool block — parallel**: two simultaneous events serialize correctly, no race on count
- **Tool block — persist**: `"finished"` clears tracking state, message remains in chat
- **Telegram size guard**: block > 3,800 chars triggers new message, old block unchanged
- **Slack/Discord regression**: `"tool_call"` event type is silently ignored
