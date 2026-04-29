# Assistant Text Auto-Forward Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `MessageChannel` as the primary response mechanism with automatic `assistant_text` forwarding, splitting channel side-effects into `ChannelAction` (interactive) and `NotifyUser` (scheduled) tools.

**Architecture:** The turn listener calls `dispatchAutoForward` at `end_turn` with the final accumulated text; each adapter either sends immediately (Telegram, Slack, Discord) or stores the text for dispatch in the `finished` lifecycle handler (Matrix, which must coordinate with thinking-block finalization). A new `activeTurnContextByConversationId` map in the registry lets `ChannelAction` resolve the inbound chat/thread/message IDs without the agent supplying them. `NotifyUser` takes explicit targeting and is used exclusively in scheduled runs.

**Tech Stack:** TypeScript, Bun, Letta agent SDK, Grammy (Telegram), matrix-js-sdk (Matrix)

---

## File Map

| File | Change |
|------|--------|
| `src/channels/registry.ts` | Add `handleAutoForward?` + `getLastSentMessageId?` to `ChannelAdapter`; add `dispatchAutoForward`, `setActiveTurnContext`, `clearActiveTurnContext`, `getActiveTurnContext`, `getLastSentMessageId` to `ChannelRegistry` |
| `src/websocket/listener/queue.ts` | Set/clear turn context in registry around each turn; call `dispatchAutoForward` before `finished` event |
| `src/websocket/listener/turn.ts` | Store final `accumulatedChannelText` on runtime so queue.ts can read it |
| `src/channels/matrix/adapter.ts` | Add `handleAutoForward` (stores pending text), update `finished` handler to send stored text, add `lastSentMessageIdByConversationId` |
| `src/channels/telegram/adapter.ts` | Add `handleAutoForward` (sends immediately), add `lastSentMessageIdByConversationId` |
| `src/channels/slack/adapter.ts` | Add `handleAutoForward` (sends immediately) |
| `src/channels/discord/adapter.ts` | Add `handleAutoForward` if it exists |
| `src/tools/impl/ChannelAction.ts` | New: react, edit, thread-reply, upload-file with context resolved from registry |
| `src/tools/impl/NotifyUser.ts` | New: explicit-target send for scheduled runs |
| `src/tools/toolDefinitions.ts` | Add `ChannelAction`, `NotifyUser`; remove `MessageChannel` |
| `src/tools/toolset.ts` | Replace `MessageChannel` with `ChannelAction` in registration logic |
| `src/tools/manager.ts` | Inject `parentScope` for `ChannelAction` + `NotifyUser` (rename from `MessageChannel`) |
| `src/channels/xml.ts` | Replace Response Directives section |
| `src/cron/scheduler.ts` | Add quiet-run + available-targets section to `wrapCronPrompt` |
| `src/tools/impl/MessageChannel.ts` | Delete after all tasks complete |

---

## Task 1: Registry — turn context + auto-forward interface

**Files:**
- Modify: `src/channels/registry.ts`
- Modify: `src/channels/types.ts` (ChannelAdapter interface lives here at line ~198)
- Test: `src/tests/channels/registry-auto-forward.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/tests/channels/registry-auto-forward.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test";

describe("ChannelRegistry turn context", () => {
  let registry: ChannelRegistry;

  beforeEach(() => {
    // Reset singleton
    (globalThis as any).__channelRegistryInstance = null;
    registry = new ChannelRegistry();
  });

  test("setActiveTurnContext stores and getActiveTurnContext retrieves", () => {
    const source: ChannelTurnSource = {
      channel: "telegram",
      chatId: "123",
      agentId: "agent-1",
      conversationId: "conv-1",
    };
    registry.setActiveTurnContext("conv-1", source);
    expect(registry.getActiveTurnContext("conv-1")).toEqual(source);
  });

  test("clearActiveTurnContext removes the entry", () => {
    registry.setActiveTurnContext("conv-1", { channel: "telegram", chatId: "123", agentId: "a", conversationId: "conv-1" });
    registry.clearActiveTurnContext("conv-1");
    expect(registry.getActiveTurnContext("conv-1")).toBeNull();
  });
});

describe("ChannelRegistry dispatchAutoForward", () => {
  test("calls handleAutoForward on matching adapter grouped by adapter", async () => {
    const registry = new ChannelRegistry();
    const calls: Array<{ text: string; sources: ChannelTurnSource[] }> = [];
    const adapter = {
      id: "telegram",
      channelId: "telegram" as SupportedChannelId,
      accountId: undefined,
      name: "test",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "1" }),
      sendDirectReply: async () => {},
      handleAutoForward: async (text: string, sources: ChannelTurnSource[]) => {
        calls.push({ text, sources });
        return "msg-1";
      },
    };
    registry.registerAdapter(adapter);

    const sources: ChannelTurnSource[] = [
      { channel: "telegram", chatId: "123", agentId: "a", conversationId: "c1" },
    ];
    await registry.dispatchAutoForward("Hello", sources);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("Hello");
  });

  test("skips adapters without handleAutoForward", async () => {
    const registry = new ChannelRegistry();
    const adapter = {
      id: "telegram",
      channelId: "telegram" as SupportedChannelId,
      accountId: undefined,
      name: "test",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "1" }),
      sendDirectReply: async () => {},
    };
    registry.registerAdapter(adapter);
    // Should not throw
    await expect(registry.dispatchAutoForward("Hello", [
      { channel: "telegram", chatId: "123", agentId: "a", conversationId: "c1" },
    ])).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/tests/channels/registry-auto-forward.test.ts
```
Expected: FAIL — `setActiveTurnContext is not a function`

- [ ] **Step 3: Add `handleAutoForward?` and `getLastSentMessageId?` to `ChannelAdapter` in `src/channels/types.ts`**

Find the `ChannelAdapter` interface (around line 198) and add after `handleStreamReasoning?`:

```typescript
handleAutoForward?(
  text: string,
  sources: ChannelTurnSource[],
): Promise<string | undefined>;

getLastSentMessageId?(conversationId: string): string | null;
```

- [ ] **Step 4: Add turn context maps and methods to `ChannelRegistry` in `src/channels/registry.ts`**

After the `private readonly pendingControlRequestIdByScope` line in the class body (around line 251), add:

```typescript
private readonly activeTurnContextByConversationId = new Map<string, ChannelTurnSource>();
```

After the `getActiveChannelIds()` method (around line 296), add:

```typescript
setActiveTurnContext(conversationId: string, source: ChannelTurnSource): void {
  this.activeTurnContextByConversationId.set(conversationId, source);
}

clearActiveTurnContext(conversationId: string): void {
  this.activeTurnContextByConversationId.delete(conversationId);
}

getActiveTurnContext(conversationId: string): ChannelTurnSource | null {
  return this.activeTurnContextByConversationId.get(conversationId) ?? null;
}

getLastSentMessageId(
  channel: string,
  accountId: string | undefined,
  conversationId: string,
): string | null {
  const adapter = this.getAdapter(channel, accountId);
  return adapter?.getLastSentMessageId?.(conversationId) ?? null;
}
```

- [ ] **Step 5: Add `dispatchAutoForward` to `ChannelRegistry` in `src/channels/registry.ts`**

After `dispatchStreamReasoning` (around line 487), add:

```typescript
async dispatchAutoForward(
  text: string,
  sources: ChannelTurnSource[],
): Promise<void> {
  const groups = new Map<
    string,
    { adapter: ChannelAdapter; sources: ChannelTurnSource[] }
  >();

  for (const source of sources) {
    const adapter = this.getAdapter(
      source.channel,
      source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
    );
    if (!adapter?.handleAutoForward) {
      continue;
    }
    const groupKey = this.getAdapterKey(
      source.channel,
      source.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID,
    );
    const existing = groups.get(groupKey);
    if (existing) {
      existing.sources.push(source);
      continue;
    }
    groups.set(groupKey, { adapter, sources: [source] });
  }

  for (const { adapter, sources: groupedSources } of groups.values()) {
    try {
      await adapter.handleAutoForward!(text, groupedSources);
    } catch (error) {
      console.error(
        `[Channels] dispatchAutoForward failed for ${adapter.channelId ?? adapter.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
```

- [ ] **Step 6: Run tests to confirm they pass**

```bash
bun test src/tests/channels/registry-auto-forward.test.ts
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/channels/types.ts src/channels/registry.ts src/tests/channels/registry-auto-forward.test.ts
git commit -m "feat(channels): add dispatchAutoForward + turn context tracking to registry"
```

---

## Task 2: queue.ts — wire turn context + trigger auto-forward

**Files:**
- Modify: `src/websocket/listener/queue.ts`

The key section is around lines 461-488 where `channelTurnSources` is used.

- [ ] **Step 1: Add turn context registration after line 471 (`runtime.activeChannelTurnSources = channelTurnSources`)**

```typescript
runtime.activeChannelTurnSources = channelTurnSources;
// Register per-conversation turn context so ChannelAction can resolve inbound chat/thread IDs
const channelRegistry = getChannelRegistry();
for (const source of channelTurnSources) {
  channelRegistry?.setActiveTurnContext(source.conversationId, source);
}
```

- [ ] **Step 2: Add auto-forward + context cleanup to the `finally` block**

Replace the finally block (currently lines 478-488) with:

```typescript
} finally {
  runtime.activeChannelTurnSources = null;
  const channelRegistry = getChannelRegistry();
  for (const source of channelTurnSources) {
    channelRegistry?.clearActiveTurnContext(source.conversationId);
  }
  if (channelTurnSources.length > 0) {
    // Auto-forward final assistant text before notifying adapters the turn is done.
    // Matrix's finished handler reads the pending text we store here.
    const finalText = runtime.finalAssistantText ?? null;
    runtime.finalAssistantText = null;
    if (finalText) {
      await channelRegistry?.dispatchAutoForward(finalText, channelTurnSources);
    }
    await dispatchChannelTurnLifecycleEvent({
      type: "finished",
      batchId: dequeuedBatch.batchId,
      sources: channelTurnSources,
      outcome: mapTurnLifecycleOutcome(runtime.lastStopReason, didThrow),
      ...(turnError ? { error: turnError } : {}),
    });
  }
}
```

- [ ] **Step 3: Add `finalAssistantText` to the `ConversationRuntime` type**

Find where `activeChannelTurnSources` is declared in the runtime type (search for `activeChannelTurnSources` in the runtime types file) and add alongside it:

```typescript
finalAssistantText?: string | null;
```

Search:
```bash
grep -rn "activeChannelTurnSources" /Users/joashm/Documents/Projects/letta-code/src/websocket/ | grep -v ".test.ts" | head -10
```

- [ ] **Step 4: Set `runtime.finalAssistantText` in `turn.ts` at `end_turn`**

In `src/websocket/listener/turn.ts`, in the `if (stopReason === "end_turn")` block (around line 773), before `runtime.lastStopReason = "end_turn"`, add:

```typescript
// Store final accumulated text for auto-forward in queue.ts
runtime.finalAssistantText = accumulatedChannelText || null;
```

- [ ] **Step 5: Commit**

```bash
git add src/websocket/listener/queue.ts src/websocket/listener/turn.ts
git commit -m "feat(channels): wire auto-forward dispatch + turn context tracking in queue"
```

---

## Task 3: Telegram adapter — `handleAutoForward`

**Files:**
- Modify: `src/channels/telegram/adapter.ts`
- Test: `src/tests/channels/telegram-auto-forward.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/tests/channels/telegram-auto-forward.test.ts
import { describe, test, expect } from "bun:test";

describe("Telegram handleAutoForward", () => {
  test("sends text to the chatId from the first source", async () => {
    // This is an integration seam test — we verify the adapter's
    // handleAutoForward sends the right text/chatId.
    // Full integration requires a live bot; unit test the formatting path.
    const sent: Array<{ chatId: string; text: string }> = [];

    // createTelegramAdapter is the function that builds the adapter object.
    // Inject a stub sendMessage to capture calls.
    const adapter = createTestTelegramAdapterWithSendSpy(sent);

    await adapter.handleAutoForward!("Hello world", [
      { channel: "telegram", chatId: "555", agentId: "a", conversationId: "c1" },
    ]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatId: "555", text: "Hello world" });
  });

  test("stores last sent message id by conversationId", async () => {
    const adapter = createTestTelegramAdapterWithSendSpy([]);
    await adapter.handleAutoForward!("Hi", [
      { channel: "telegram", chatId: "555", agentId: "a", conversationId: "c1" },
    ]);
    expect(adapter.getLastSentMessageId!("c1")).toBeDefined();
  });
});
```

Note: `createTestTelegramAdapterWithSendSpy` is a test helper you'll add to the test file itself. It calls `createTelegramAdapter()` but stubs the bot instance. If the adapter factory isn't easily extractable for testing, test `getLastSentMessageId` with a direct state manipulation seam exposed for testing only.

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test src/tests/channels/telegram-auto-forward.test.ts
```
Expected: FAIL — `handleAutoForward is not a function`

- [ ] **Step 3: Add `lastSentMessageIdByConversationId` map to telegram adapter state**

In `src/channels/telegram/adapter.ts`, after the existing state maps (around line 255), add:

```typescript
const lastSentMessageIdByConversationId = new Map<string, string>();
```

- [ ] **Step 4: Add `handleAutoForward` and `getLastSentMessageId` to the adapter object**

In the adapter object (after `sendDirectReply`, around line 1063), add:

```typescript
async handleAutoForward(
  text: string,
  sources: ChannelTurnSource[],
): Promise<string | undefined> {
  const source = sources[0];
  if (!source) return undefined;
  const telegramBot = await ensureBot();
  const result = await telegramBot.api.sendMessage(
    source.chatId,
    markdownToTelegramHtml(text),
    { parse_mode: "HTML" },
  );
  const messageId = String(result.message_id);
  lastSentMessageIdByConversationId.set(source.conversationId, messageId);
  return messageId;
},

getLastSentMessageId(conversationId: string): string | null {
  return lastSentMessageIdByConversationId.get(conversationId) ?? null;
},
```

Note: `markdownToTelegramHtml` is already imported/defined in `MessageChannel.ts` — move it to a shared location (`src/channels/telegram/format.ts`) and import from there in both the adapter and `NotifyUser` tool. If refactoring the formatter is too large in scope, inline the call or import from `MessageChannel.ts` directly as a temporary measure.

- [ ] **Step 5: Run tests**

```bash
bun test src/tests/channels/telegram-auto-forward.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/channels/telegram/adapter.ts src/tests/channels/telegram-auto-forward.test.ts
git commit -m "feat(channels/telegram): add handleAutoForward + lastSentMessageId tracking"
```

---

## Task 4: Matrix adapter — `handleAutoForward` + deferred send in `finished`

**Files:**
- Modify: `src/channels/matrix/adapter.ts`
- Test: `src/tests/channels/matrix-auto-forward.test.ts`

The Matrix adapter must coordinate with thinking-block finalization: `handleAutoForward` stores the text; the `finished` lifecycle handler sends it as a new message (and may embed a thinking drawer). This is because Matrix's `finalizeReasoningMessage` must delete the thinking placeholder _before_ sending the response, and that finalization happens in `finished`.

- [ ] **Step 1: Write failing test**

```typescript
// src/tests/channels/matrix-auto-forward.test.ts
import { describe, test, expect } from "bun:test";

describe("Matrix handleAutoForward", () => {
  test("stores text for later send — does not send immediately", async () => {
    const sentMessages: unknown[] = [];
    const adapter = buildTestMatrixAdapter({ onSend: (m) => sentMessages.push(m) });

    await adapter.handleAutoForward!("Hello", [
      { channel: "matrix", chatId: "!room:server", agentId: "a", conversationId: "c1" },
    ]);

    // Not sent yet — stored for finished handler
    expect(sentMessages).toHaveLength(0);
  });

  test("getLastSentMessageId returns null before any send", () => {
    const adapter = buildTestMatrixAdapter({ onSend: () => {} });
    expect(adapter.getLastSentMessageId!("c1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test src/tests/channels/matrix-auto-forward.test.ts
```
Expected: FAIL — `handleAutoForward is not a function`

- [ ] **Step 3: Add state maps to matrix adapter**

In `src/channels/matrix/adapter.ts`, after the existing state maps (around line 336), add:

```typescript
// Text stored by handleAutoForward, sent by the "finished" lifecycle handler
// after thinking-block finalization to maintain correct Matrix timeline order.
const pendingResponseTextByChatId = new Map<string, string>();
const lastSentMessageIdByConversationId = new Map<string, string>();
```

- [ ] **Step 4: Add `handleAutoForward` and `getLastSentMessageId` to the adapter object**

After `sendDirectReply` (around line 1127), add:

```typescript
async handleAutoForward(
  text: string,
  sources: ChannelTurnSource[],
): Promise<string | undefined> {
  for (const source of sources) {
    pendingResponseTextByChatId.set(source.chatId, text);
  }
  return undefined; // actual send deferred to "finished" handler
},

getLastSentMessageId(conversationId: string): string | null {
  return lastSentMessageIdByConversationId.get(conversationId) ?? null;
},
```

- [ ] **Step 5: Update `finished` handler to send pending response text**

In `handleTurnLifecycleEvent`, in the `"finished"` branch, find the `"completed"` outcome block. Currently it calls `finalizeReasoningMessage(chatId)` then appends a completion footer to `lastResponse`. Update to:

```typescript
if (event.outcome === "completed") {
  const pendingText = pendingResponseTextByChatId.get(chatId);
  pendingResponseTextByChatId.delete(chatId);

  // Finalize thinking block, then send response (order matters for Matrix timeline)
  if (pendingText) {
    await finalizeReasoningMessage(chatId);
    clearReasoningState(chatId);

    // Wait for pending tool block ops so the response appears below them
    while (toolBlockOperationByChatId.has(chatId)) {
      await toolBlockOperationByChatId.get(chatId)!.catch(() => {});
    }
    await waitForPendingPlaceholder(chatId);
    void stopTypingInterval(chatId);

    const html = markdownToMatrixHtml(pendingText);
    const content: Record<string, unknown> = {
      msgtype: "m.text",
      body: pendingText,
      format: "org.matrix.custom.html",
      formatted_body: html,
    };
    const client = await ensureClient();
    const eventId = await client.sendMessage(chatId, content);
    const messageId = String(eventId);

    // Track for ChannelAction edits and turn-state completion footer
    // (lastResponseByChatId population via sendMessage() is handled below)
    const source = event.sources.find((s) => s.chatId === chatId);
    if (source) {
      lastSentMessageIdByConversationId.set(source.conversationId, messageId);
    }

    // Append completion footer (matrix turn state indicators spec)
    // ... (existing completion footer logic, using messageId as eventId) ...
  } else {
    // No response text — just finalize thinking block
    await finalizeReasoningMessage(chatId);
    clearReasoningState(chatId);
  }
}
```

For the error and cancelled outcomes, `pendingResponseTextByChatId.delete(chatId)` before the existing finalization logic (no response was sent in those cases).

Also add to the cleanup helper:
```typescript
// In clearReasoningState or a new cleanupTurnState helper:
pendingResponseTextByChatId.delete(chatId);
```

- [ ] **Step 6: Run tests**

```bash
bun test src/tests/channels/matrix-auto-forward.test.ts
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/channels/matrix/adapter.ts src/tests/channels/matrix-auto-forward.test.ts
git commit -m "feat(channels/matrix): add handleAutoForward + deferred send in finished handler"
```

---

## Task 5: Slack + Discord adapters — `handleAutoForward`

**Files:**
- Modify: `src/channels/slack/adapter.ts`
- Modify: `src/channels/discord/adapter.ts` (if it exists and has routes)

Read each adapter's existing `sendMessage` implementation first to understand the send path, then add `handleAutoForward` following the Telegram pattern (send immediately, store message ID).

```bash
grep -n "sendMessage\|handleStreamText\|async sendMessage" \
  /Users/joashm/Documents/Projects/letta-code/src/channels/slack/adapter.ts | head -20
```

- [ ] **Step 1: Add `lastSentMessageIdByConversationId` map to Slack adapter state**

Find the state maps section in `src/channels/slack/adapter.ts` and add:

```typescript
const lastSentMessageIdByConversationId = new Map<string, string>();
```

- [ ] **Step 2: Add `handleAutoForward` + `getLastSentMessageId` to Slack adapter object**

The Slack send uses their Web API's `chat.postMessage`. Find the plain-text send path in the existing `sendMessage` and mirror it:

```typescript
async handleAutoForward(
  text: string,
  sources: ChannelTurnSource[],
): Promise<string | undefined> {
  const source = sources[0];
  if (!source) return undefined;
  // Mirror the existing plain-text sendMessage path for Slack.
  // Read sendMessage() in this file first to match the exact API call.
  const result = await slackClient.chat.postMessage({
    channel: source.chatId,
    text,
    thread_ts: source.threadId ?? undefined,
  });
  const messageId = result.ts ?? "";
  if (messageId) {
    lastSentMessageIdByConversationId.set(source.conversationId, messageId);
  }
  return messageId || undefined;
},

getLastSentMessageId(conversationId: string): string | null {
  return lastSentMessageIdByConversationId.get(conversationId) ?? null;
},
```

**Important:** Read the existing `sendMessage` in the Slack adapter before implementing to match the exact client variable name and API call pattern.

- [ ] **Step 3: Add `handleAutoForward` + `getLastSentMessageId` to Discord adapter (if active)**

Check if Discord routes are in active use:
```bash
grep -rn "discord" /Users/joashm/Documents/Projects/letta-code/src/channels/routing.ts | head -5
```

If Discord is wired up, follow the same pattern as Slack.

- [ ] **Step 4: Commit**

```bash
git add src/channels/slack/adapter.ts src/channels/discord/adapter.ts
git commit -m "feat(channels): add handleAutoForward to Slack and Discord adapters"
```

---

## Task 6: `ChannelAction` tool

**Files:**
- Create: `src/tools/impl/ChannelAction.ts`
- Test: `src/tests/tools/channel-action.test.ts`

This replaces `MessageChannel` for side-effect actions (react, edit, thread-reply, upload-file). Context (channel, chatId, threadId, messageId) is resolved from the registry's active turn context — the agent does not supply these.

- [ ] **Step 1: Write failing tests**

```typescript
// src/tests/tools/channel-action.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { channel_action } from "../../tools/impl/ChannelAction";

// Test using object-level stubbing rather than module mocks.
// We inject a fake registry and fake plugin via the exported test seam.

describe("channel_action — react", () => {
  test("returns error when no active turn context for conversationId", async () => {
    const result = await channel_action(
      { action: "react", emoji: "👍" },
      { parentScope: { agentId: "a", conversationId: "c-no-context" }, registry: fakeEmptyRegistry() },
    );
    expect(result).toContain("No active turn context");
  });

  test("dispatches react via plugin with resolved chatId and messageId", async () => {
    const dispatched: unknown[] = [];
    const result = await channel_action(
      { action: "react", emoji: "👍" },
      {
        parentScope: { agentId: "a", conversationId: "c1" },
        registry: fakeRegistryWithContext({
          conversationId: "c1",
          source: { channel: "telegram", chatId: "555", messageId: "99", agentId: "a", conversationId: "c1" },
          onAction: (req) => { dispatched.push(req); return "ok"; },
        }),
      },
    );
    expect(result).toBe("ok");
    expect(dispatched[0]).toMatchObject({ action: "react", chatId: "555", messageId: "99", emoji: "👍" });
  });
});

describe("channel_action — edit", () => {
  test("returns error when no last sent message id exists", async () => {
    const result = await channel_action(
      { action: "edit", text: "Updated text" },
      {
        parentScope: { agentId: "a", conversationId: "c1" },
        registry: fakeRegistryWithContext({
          conversationId: "c1",
          source: { channel: "telegram", chatId: "555", agentId: "a", conversationId: "c1" },
          lastSentMessageId: null,
          onAction: () => "ok",
        }),
      },
    );
    expect(result).toContain("No previous message to edit");
  });

  test("dispatches edit with resolved last sent message id", async () => {
    const dispatched: unknown[] = [];
    const result = await channel_action(
      { action: "edit", text: "New content" },
      {
        parentScope: { agentId: "a", conversationId: "c1" },
        registry: fakeRegistryWithContext({
          conversationId: "c1",
          source: { channel: "telegram", chatId: "555", agentId: "a", conversationId: "c1" },
          lastSentMessageId: "42",
          onAction: (req) => { dispatched.push(req); return "ok"; },
        }),
      },
    );
    expect(dispatched[0]).toMatchObject({ action: "edit", messageId: "42", message: "New content" });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/tests/tools/channel-action.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement `ChannelAction.ts`**

```typescript
// src/tools/impl/ChannelAction.ts
import { getChannelRegistry } from "../../channels/registry";
import { loadChannelPlugin } from "../../channels/pluginRegistry";
import { formatOutboundChannelMessage } from "./MessageChannel"; // move this helper if desired

export type ChannelActionArgs = {
  action: "react" | "edit" | "thread-reply" | "upload-file";
  // react
  emoji?: string;
  remove?: boolean;
  // edit
  text?: string;
  // thread-reply
  thread_id?: string;
  message?: string;
  // upload-file
  file_path?: string;
  url?: string;
  caption?: string;
  // injected by executeTool
  parentScope?: { agentId: string; conversationId: string };
};

// Test seam: injected registry (for unit tests) vs. singleton (production)
type ChannelActionDeps = {
  parentScope?: { agentId: string; conversationId: string };
  registry?: ReturnType<typeof getChannelRegistry>;
};

export async function channel_action(
  args: ChannelActionArgs,
  deps?: ChannelActionDeps,
): Promise<string> {
  const scope = deps?.parentScope ?? args.parentScope;
  if (!scope) {
    return "Error: ChannelAction requires execution scope (agentId + conversationId).";
  }

  const registry = deps?.registry ?? getChannelRegistry();
  if (!registry) {
    return "Error: Channel system is not initialized.";
  }

  const context = registry.getActiveTurnContext(scope.conversationId);
  if (!context) {
    return "Error: No active turn context for this conversation. ChannelAction can only be used during an inbound channel turn.";
  }

  const { channel, chatId, threadId, messageId, accountId } = context;

  const route = registry.getRouteForScope(channel, chatId, scope.agentId, scope.conversationId);
  if (!route) {
    return `Error: No route for chat_id "${chatId}" on "${channel}" for this agent/conversation.`;
  }

  const adapter = registry.getAdapter(channel, route.accountId);
  if (!adapter?.isRunning()) {
    return `Error: Channel "${channel}" is not currently running.`;
  }

  const plugin = await loadChannelPlugin(channel);
  if (!plugin.messageActions) {
    return `Error: Channel "${channel}" does not expose message actions.`;
  }

  if (args.action === "react") {
    if (!args.emoji) return "Error: react requires emoji.";
    return await plugin.messageActions.handleAction({
      request: {
        action: "react",
        channel,
        chatId,
        messageId: messageId ?? "",
        emoji: args.emoji,
        remove: args.remove ?? false,
        threadId: threadId ?? null,
      },
      route,
      adapter,
      formatText: (t) => formatOutboundChannelMessage(channel, t),
    });
  }

  if (args.action === "edit") {
    const targetMessageId = registry.getLastSentMessageId(channel, accountId, scope.conversationId);
    if (!targetMessageId) {
      return "Error: No previous message to edit in this conversation.";
    }
    if (!args.text) return "Error: edit requires text.";
    return await plugin.messageActions.handleAction({
      request: {
        action: "edit",
        channel,
        chatId,
        messageId: targetMessageId,
        message: args.text,
        threadId: threadId ?? null,
      },
      route,
      adapter,
      formatText: (t) => formatOutboundChannelMessage(channel, t),
    });
  }

  if (args.action === "thread-reply") {
    if (!args.message) return "Error: thread-reply requires message.";
    return await plugin.messageActions.handleAction({
      request: {
        action: "send",
        channel,
        chatId,
        message: args.message,
        threadId: args.thread_id ?? threadId ?? null,
      },
      route,
      adapter,
      formatText: (t) => formatOutboundChannelMessage(channel, t),
    });
  }

  if (args.action === "upload-file") {
    const mediaPath = args.file_path ?? args.url;
    if (!mediaPath) return "Error: upload-file requires file_path or url.";
    return await plugin.messageActions.handleAction({
      request: {
        action: "upload-file",
        channel,
        chatId,
        mediaPath,
        title: args.caption,
        threadId: threadId ?? null,
      },
      route,
      adapter,
      formatText: (t) => formatOutboundChannelMessage(channel, t),
    });
  }

  return `Error: Unknown action "${args.action}".`;
}
```

- [ ] **Step 4: Add the schema and description constants (same file or a sibling)**

```typescript
export const ChannelActionSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["react", "edit", "thread-reply", "upload-file"],
      description: "The side-effect action to perform on the channel.",
    },
    emoji: { type: "string", description: "Emoji for react action." },
    remove: { type: "boolean", description: "If true, removes the reaction." },
    text: { type: "string", description: "New text for edit action." },
    thread_id: { type: "string", description: "Thread ID override for thread-reply (defaults to inbound thread)." },
    message: { type: "string", description: "Message text for thread-reply." },
    file_path: { type: "string", description: "Local file path for upload-file." },
    url: { type: "string", description: "URL for upload-file." },
    caption: { type: "string", description: "Caption for upload-file." },
  },
  required: ["action"],
};

export const ChannelActionDescription = `
Perform a channel side-effect during an inbound channel turn. Your reply text is delivered automatically — use ChannelAction only for:
- react: add or remove a reaction on the inbound message
- edit: edit your most recently sent message in this conversation
- thread-reply: send a message into a specific thread (defaults to inbound thread)
- upload-file: send a file or media to the channel

Channel and chat context are resolved automatically from the inbound turn.
`.trim();
```

- [ ] **Step 5: Run tests**

```bash
bun test src/tests/tools/channel-action.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/impl/ChannelAction.ts src/tests/tools/channel-action.test.ts
git commit -m "feat(tools): add ChannelAction tool for channel side-effects"
```

---

## Task 7: `NotifyUser` tool

**Files:**
- Create: `src/tools/impl/NotifyUser.ts`
- Test: `src/tests/tools/notify-user.test.ts`

Used exclusively in scheduled/cron runs. Explicit targeting — no inbound context.

- [ ] **Step 1: Write failing test**

```typescript
// src/tests/tools/notify-user.test.ts
import { describe, test, expect } from "bun:test";
import { notify_user } from "../../tools/impl/NotifyUser";

describe("notify_user", () => {
  test("returns error when scope is missing", async () => {
    const result = await notify_user(
      { channel: "telegram", chat_id: "123", message: "Hello" },
      { registry: fakeEmptyRegistry() },
    );
    expect(result).toContain("requires execution scope");
  });

  test("dispatches send via plugin with explicit channel/chat_id", async () => {
    const dispatched: unknown[] = [];
    const result = await notify_user(
      { channel: "telegram", chat_id: "555", message: "Scheduled hello" },
      {
        parentScope: { agentId: "a", conversationId: "c1" },
        registry: fakeRegistryForNotify({
          channel: "telegram",
          chatId: "555",
          agentId: "a",
          conversationId: "c1",
          onAction: (req) => { dispatched.push(req); return "sent"; },
        }),
      },
    );
    expect(result).toBe("sent");
    expect(dispatched[0]).toMatchObject({ action: "send", chatId: "555", message: "Scheduled hello" });
  });

  test("returns error when no route found for explicit chat_id", async () => {
    const result = await notify_user(
      { channel: "telegram", chat_id: "no-such-chat", message: "Hi" },
      {
        parentScope: { agentId: "a", conversationId: "c1" },
        registry: fakeEmptyRegistry(),
      },
    );
    expect(result).toContain("No route");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test src/tests/tools/notify-user.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement `NotifyUser.ts`**

```typescript
// src/tools/impl/NotifyUser.ts
import { getChannelRegistry } from "../../channels/registry";
import { loadChannelPlugin } from "../../channels/pluginRegistry";
import { formatOutboundChannelMessage } from "./MessageChannel";

export type NotifyUserArgs = {
  channel: string;
  chat_id: string;
  thread_id?: string;
  message: string;
  parentScope?: { agentId: string; conversationId: string };
};

type NotifyUserDeps = {
  parentScope?: { agentId: string; conversationId: string };
  registry?: ReturnType<typeof getChannelRegistry>;
};

export async function notify_user(
  args: NotifyUserArgs,
  deps?: NotifyUserDeps,
): Promise<string> {
  const scope = deps?.parentScope ?? args.parentScope;
  if (!scope) {
    return "Error: NotifyUser requires execution scope (agentId + conversationId).";
  }

  const registry = deps?.registry ?? getChannelRegistry();
  if (!registry) {
    return "Error: Channel system is not initialized.";
  }

  const route = registry.getRouteForScope(args.channel, args.chat_id, scope.agentId, scope.conversationId);
  if (!route) {
    return `Error: No route for chat_id "${args.chat_id}" on "${args.channel}" for this agent/conversation.`;
  }

  const adapter = registry.getAdapter(args.channel, route.accountId);
  if (!adapter?.isRunning()) {
    return `Error: Channel "${args.channel}" is not currently running.`;
  }

  const plugin = await loadChannelPlugin(args.channel);
  if (!plugin.messageActions) {
    return `Error: Channel "${args.channel}" does not expose message actions.`;
  }

  try {
    return await plugin.messageActions.handleAction({
      request: {
        action: "send",
        channel: args.channel as import("../../channels/types").SupportedChannelId,
        chatId: args.chat_id,
        message: args.message,
        threadId: args.thread_id ?? null,
      },
      route,
      adapter,
      formatText: (t) => formatOutboundChannelMessage(args.channel, t),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return `Error sending notification to ${args.channel}: ${msg}`;
  }
}

export const NotifyUserSchema = {
  type: "object",
  properties: {
    channel: { type: "string", description: "Channel platform (e.g. telegram, matrix, slack)." },
    chat_id: { type: "string", description: "Target chat or room ID. Use one of the available targets listed in the task context." },
    thread_id: { type: "string", description: "Optional thread ID to reply into." },
    message: { type: "string", description: "Message text to send." },
  },
  required: ["channel", "chat_id", "message"],
};

export const NotifyUserDescription = `
Send a message to a channel user. Use this tool during scheduled or background runs where your response text is not automatically delivered.

Supply channel and chat_id from the available targets listed in the scheduled task context.
`.trim();
```

- [ ] **Step 4: Run tests**

```bash
bun test src/tests/tools/notify-user.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/impl/NotifyUser.ts src/tests/tools/notify-user.test.ts
git commit -m "feat(tools): add NotifyUser tool for scheduled run outreach"
```

---

## Task 8: Tool registrations

**Files:**
- Modify: `src/tools/toolDefinitions.ts`
- Modify: `src/tools/toolset.ts`
- Modify: `src/tools/manager.ts`

- [ ] **Step 1: Add `ChannelAction` and `NotifyUser` to `toolDefinitions.ts`**

In `src/tools/toolDefinitions.ts`, import the new tools and add their definitions alongside the existing `MessageChannel` entry:

```typescript
import { channel_action, ChannelActionSchema, ChannelActionDescription } from "./impl/ChannelAction";
import { notify_user, NotifyUserSchema, NotifyUserDescription } from "./impl/NotifyUser";

// In the toolDefinitions object:
ChannelAction: {
  schema: ChannelActionSchema,
  description: ChannelActionDescription,
  impl: channel_action as unknown as ToolImplementation,
},
NotifyUser: {
  schema: NotifyUserSchema,
  description: NotifyUserDescription,
  impl: notify_user as unknown as ToolImplementation,
},
```

Keep `MessageChannel` registered for now (will be removed in Task 11 after all references are updated).

- [ ] **Step 2: Update `toolset.ts` to register `ChannelAction` instead of `MessageChannel`**

In `src/tools/toolset.ts`, find the block (around line 123) that pushes `"MessageChannel"` and update it:

```typescript
const hasScopedChannelTool =
  channelToolScope !== undefined
    ? (channelToolScope?.channels.length ?? 0) > 0
    : (getChannelRegistry()?.getActiveChannelIds().length ?? 0) > 0;

if (hasScopedChannelTool && !tools.includes("ChannelAction" as ToolName)) {
  tools.push("ChannelAction" as ToolName);
  tools.push("NotifyUser" as ToolName);
}
```

- [ ] **Step 3: Update `manager.ts` parentScope injection for `ChannelAction` and `NotifyUser`**

In `src/tools/manager.ts`, find the `MessageChannel` injection block (lines 1658-1661) and add/replace:

```typescript
// Inject parent scope for ChannelAction tool
if (internalName === "ChannelAction" && options?.parentScope) {
  enhancedArgs = { ...enhancedArgs, parentScope: options.parentScope };
}

// Inject parent scope for NotifyUser tool
if (internalName === "NotifyUser" && options?.parentScope) {
  enhancedArgs = { ...enhancedArgs, parentScope: options.parentScope };
}
```

Keep the `MessageChannel` injection as-is for now.

- [ ] **Step 4: Run the full test suite to check for regressions**

```bash
bun test src/tests/tools/
```
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/tools/toolDefinitions.ts src/tools/toolset.ts src/tools/manager.ts
git commit -m "feat(tools): register ChannelAction and NotifyUser, wire parentScope injection"
```

---

## Task 9: Update inbound XML reminder

**Files:**
- Modify: `src/channels/xml.ts`
- Test: `src/tests/channels/xml-response-directives.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/tests/channels/xml-response-directives.test.ts
import { test, expect } from "bun:test";
import { buildChannelReminderText } from "../../channels/xml";

test("Response Directives no longer mention MessageChannel", () => {
  const msg = makeTestInboundMessage(); // use existing test helper or build minimal fixture
  const text = buildChannelReminderText(msg);
  expect(text).not.toContain("MessageChannel");
  expect(text).not.toContain("You MUST respond via");
});

test("Response Directives explain auto-forward model", () => {
  const msg = makeTestInboundMessage();
  const text = buildChannelReminderText(msg);
  expect(text).toContain("delivered automatically");
  expect(text).toContain("ChannelAction");
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test src/tests/channels/xml-response-directives.test.ts
```
Expected: FAIL

- [ ] **Step 3: Replace `buildResponseDirectives` in `src/channels/xml.ts`**

Find `buildResponseDirectives` (around line 131) and replace the returned directive lines with:

```typescript
function buildResponseDirectives(msg: InboundChannelMessage): string[] {
  const channel = msg.channel;
  const emojiHint = msg.chatType === "group" ? "`👀`" : "`👍`";

  return [
    "**Responding:**",
    "- Your response text is delivered to the user automatically — just write your reply.",
    "- To stay silent (e.g. the message wasn't for you, or no reply is needed), produce no response text.",
    `- Use \`ChannelAction\` with \`action="react"\` for acknowledgments instead of a short text reply — prefer ${emojiHint}, \`❤️\`, \`🎉\`.`,
    `- Use \`ChannelAction\` with \`action="thread-reply"\` to reply into a specific thread rather than the main chat.`,
    `- Use \`ChannelAction\` with \`action="edit"\` to edit your most recently sent message.`,
    "- Use local file/image tools (e.g. `Read`, `ViewImage`) to inspect attachments listed in the chat context above.",
  ];
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/tests/channels/xml-response-directives.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/xml.ts src/tests/channels/xml-response-directives.test.ts
git commit -m "feat(channels): update inbound XML reminder for auto-forward model"
```

---

## Task 10: Update cron system-reminder

**Files:**
- Modify: `src/cron/scheduler.ts`
- Test: `src/tests/cron/scheduler-wrap.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/tests/cron/scheduler-wrap.test.ts
import { test, expect } from "bun:test";
import { wrapCronPrompt } from "../../cron/scheduler"; // export this function if not already exported

const baseTask = {
  id: "t1",
  name: "Daily digest",
  description: "Send daily summary",
  prompt: "Summarize today's events.",
  recurring: true,
  cron: "0 9 * * *",
  fire_count: 2,
  agent_id: "a1",
  conversation_id: "c1",
  status: "active" as const,
  timezone: "UTC",
};

test("wrapCronPrompt includes NotifyUser instruction", () => {
  const result = wrapCronPrompt(baseTask, []);
  expect(result).toContain("NotifyUser");
  expect(result).toContain("not delivered automatically");
});

test("wrapCronPrompt includes available targets when provided", () => {
  const targets = [
    { channel: "telegram", chatId: "-100123", label: "Main chat" },
  ];
  const result = wrapCronPrompt(baseTask, targets);
  expect(result).toContain("telegram");
  expect(result).toContain("-100123");
});

test("wrapCronPrompt includes no targets section when targets is empty", () => {
  const result = wrapCronPrompt(baseTask, []);
  expect(result).not.toContain("Available targets");
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test src/tests/cron/scheduler-wrap.test.ts
```
Expected: FAIL — `wrapCronPrompt` not exported or missing NotifyUser text

- [ ] **Step 3: Update `wrapCronPrompt` in `src/cron/scheduler.ts`**

Find `wrapCronPrompt` (around line 76) and update. Also add a `CronTarget` type and a targets parameter:

```typescript
export interface CronTarget {
  channel: string;
  chatId: string;
  label?: string;
}

export function wrapCronPrompt(task: CronTask, targets: CronTarget[]): string {
  const targetLines =
    targets.length > 0
      ? [
          "",
          "**Available targets (for NotifyUser):**",
          ...targets.map(
            (t) =>
              `- channel: \`${t.channel}\`, chat_id: \`${t.chatId}\`${t.label ? ` (${t.label})` : ""}`,
          ),
        ]
      : [];

  const lines = [
    "<system-reminder>",
    `Scheduled task "${task.name}" is firing.`,
    `Description: ${task.description}`,
    task.recurring
      ? `This is fire #${task.fire_count + 1} (cron: ${task.cron}).`
      : `This is a one-off scheduled task.`,
    "",
    "**Quiet run — no inbound message.**",
    "Your response text is NOT delivered automatically in scheduled runs.",
    "Use the `NotifyUser` tool to send a message to a channel user.",
    "If no notification is needed, produce no response text.",
    ...targetLines,
    "",
    task.prompt,
    "</system-reminder>",
  ];
  return lines.join("\n");
}
```

- [ ] **Step 4: Update the call site that invokes `wrapCronPrompt`**

Find where `wrapCronPrompt` is called (in `scheduler.ts` around line 139) and pass the resolved targets. The targets come from the channel registry — active routes for the task's `agent_id` + `conversation_id`:

```typescript
import { resolveConversationChannelToolScope } from "../tools/toolset";
import { getRoutesForChannel } from "../channels/routing";

function resolveTargetsForTask(task: CronTask): CronTarget[] {
  const scope = resolveConversationChannelToolScope(task.agent_id, task.conversation_id);
  return scope.channels.map((ch) => ({
    channel: ch.channelId,
    chatId: getFirstChatIdForRoute(ch.channelId, ch.accountId, task.agent_id, task.conversation_id) ?? "",
  })).filter((t) => t.chatId !== "");
}

function getFirstChatIdForRoute(
  channelId: string,
  accountId: string | null | undefined,
  agentId: string,
  conversationId: string,
): string | null {
  for (const route of getRoutesForChannel(channelId)) {
    if (route.agentId === agentId && route.conversationId === conversationId && route.enabled) {
      return route.chatId ?? null;
    }
  }
  return null;
}
```

Then call: `wrapCronPrompt(task, resolveTargetsForTask(task))`

- [ ] **Step 5: Run tests**

```bash
bun test src/tests/cron/scheduler-wrap.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/cron/scheduler.ts src/tests/cron/scheduler-wrap.test.ts
git commit -m "feat(cron): add quiet-run context and NotifyUser targets to cron system-reminder"
```

---

## Task 11: Remove `MessageChannel`

**Files:**
- Delete: `src/tools/impl/MessageChannel.ts`
- Modify: `src/tools/toolDefinitions.ts` (remove MessageChannel entry)
- Modify: `src/tools/toolset.ts` (remove any remaining MessageChannel references)
- Modify: `src/tools/manager.ts` (remove MessageChannel parentScope injection)

Only do this after all tests pass.

- [ ] **Step 1: Check for remaining MessageChannel references**

```bash
grep -rn "MessageChannel" /Users/joashm/Documents/Projects/letta-code/src/ \
  --include="*.ts" --include="*.tsx" | grep -v ".test.ts" | grep -v "node_modules"
```

Fix or remove each reference. The key ones are:
- `toolDefinitions.ts`: remove the `MessageChannel` entry
- `toolset.ts`: remove the old `"MessageChannel"` string reference
- `manager.ts`: remove the `internalName === "MessageChannel"` block
- Any import of `message_channel` or `MessageChannelArgs`

- [ ] **Step 2: Move shared helpers out of `MessageChannel.ts` if needed**

If `formatOutboundChannelMessage`, `markdownToTelegramHtml`, or other helpers are imported by `ChannelAction.ts` or `NotifyUser.ts`, move them to `src/channels/format.ts` first. Update import paths.

- [ ] **Step 3: Delete `MessageChannel.ts`**

```bash
rm src/tools/impl/MessageChannel.ts
```

- [ ] **Step 4: Run full test suite**

```bash
bun test src/
```
Expected: All pass, no references to MessageChannel remaining

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tools): remove MessageChannel tool, complete auto-forward migration"
```

---

## Spec coverage check

| Spec requirement | Covered by |
|---|---|
| `assistant_text` auto-forwards in interactive runs | Tasks 2 + 3/4/5 |
| Silence = no `assistant_text` | No code change needed — turn ends without auto-forward call |
| `ChannelAction`: react, edit, thread-reply, upload | Task 6 |
| `ChannelAction` resolves context internally | Task 6 (registry turn context lookup) |
| Edit targets most recent sent message | Tasks 3/4/5 (lastSentMessageIdByConversationId) + Task 6 |
| `NotifyUser` for scheduled runs with explicit targeting | Task 7 |
| Scheduler injects available targets into cron reminder | Task 10 |
| `ChannelAction` not available in scheduled runs | Task 8 (both tools always registered; XML/cron context guides model — conditional registration is a follow-up) |
| Inbound XML reminder updated | Task 9 |
| Streaming layer unchanged | No task — `dispatchStreamText` is not modified |
| Matrix thinking-block coordination preserved | Task 4 (deferred send in `finished` handler) |
