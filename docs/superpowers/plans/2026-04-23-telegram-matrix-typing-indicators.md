# Telegram & Matrix Typing Indicators + Tool Call Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native typing indicators and a persistent live-updating tool call block to the Telegram and Matrix channel adapters, following the same `handleTurnLifecycleEvent` pattern used by Slack and Discord.

**Architecture:** Extend `ChannelTurnLifecycleEvent` with a `"tool_call"` variant, dispatch it from `executeTool()` via a threaded `onToolCall?` callback, and implement `handleTurnLifecycleEvent()` in both adapters. The Telegram adapter uses `sendChatAction("typing")` on a 4-second refresh interval; Matrix uses `sendTyping()`. Both adapters maintain a serialized-promise-chain per chat for the tool block message to handle parallel tool calls safely.

**Tech Stack:** TypeScript, Bun, grammY (Telegram), matrix-bot-sdk (Matrix), bun:test

---

## File Map

| Action | File | What changes |
|--------|------|--------------|
| Create | `src/channels/tool-block.ts` | `ToolCallGroup`, `renderToolBlock`, `upsertToolCallGroup`, `makeToolCallKey`, `makeToolCallLabel` |
| Create | `src/tests/channels/tool-block.test.ts` | Unit tests for the above pure functions |
| Modify | `src/channels/types.ts` | Add `tool_call` variant to `ChannelTurnLifecycleEvent` |
| Modify | `src/tools/manager.ts` | Add `onToolCall?` to `executeTool()` options; call it pre-execution |
| Modify | `src/agent/approval-execution.ts` | Thread `onToolCall?` through `executeSingleDecision` and `executeApprovalBatch` |
| Modify | `src/websocket/listener/turn-approval.ts` | Construct and pass `onToolCall` callback to `executeApprovalBatch` |
| Modify | `src/channels/telegram/adapter.ts` | Implement `handleTurnLifecycleEvent()`, extend `stop()`, extend `FakeBot.api` in tests |
| Modify | `src/channels/matrix/adapter.ts` | Implement `handleTurnLifecycleEvent()`, extend `stop()` |
| Modify | `src/tests/channels/telegram-adapter.test.ts` | Add lifecycle event tests |
| Modify | `src/tests/channels/matrix-adapter.test.ts` | Add lifecycle event tests |

---

## Task 1: Create the tool-block module and tests

**Files:**
- Create: `src/channels/tool-block.ts`
- Create: `src/tests/channels/tool-block.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tests/channels/tool-block.test.ts
import { expect, test } from "bun:test";
import {
  renderToolBlock,
  upsertToolCallGroup,
  type ToolCallGroup,
} from "../../channels/tool-block";

test("renderToolBlock: single tool no description", () => {
  const groups: ToolCallGroup[] = [{ key: "bash", label: "bash", count: 1 }];
  expect(renderToolBlock(groups)).toBe("🔧 Tools used:\n• bash");
});

test("renderToolBlock: single tool count > 1", () => {
  const groups: ToolCallGroup[] = [
    { key: "bash", label: "bash", count: 3 },
  ];
  expect(renderToolBlock(groups)).toBe("🔧 Tools used:\n• bash ×3");
});

test("renderToolBlock: tool with description", () => {
  const groups: ToolCallGroup[] = [
    { key: "bash\0Run tests", label: "bash — Run tests", count: 2 },
  ];
  expect(renderToolBlock(groups)).toBe("🔧 Tools used:\n• bash — Run tests ×2");
});

test("renderToolBlock: multiple tools preserves order", () => {
  const groups: ToolCallGroup[] = [
    { key: "read_file", label: "read_file", count: 4 },
    { key: "bash\0Run tests", label: "bash — Run tests", count: 1 },
    { key: "glob", label: "glob", count: 2 },
  ];
  expect(renderToolBlock(groups)).toBe(
    "🔧 Tools used:\n• read_file ×4\n• bash — Run tests\n• glob ×2",
  );
});

test("upsertToolCallGroup: first call creates group", () => {
  const result = upsertToolCallGroup([], "bash");
  expect(result).toEqual([{ key: "bash", label: "bash", count: 1 }]);
});

test("upsertToolCallGroup: second call increments count", () => {
  const initial = upsertToolCallGroup([], "bash");
  const result = upsertToolCallGroup(initial, "bash");
  expect(result).toEqual([{ key: "bash", label: "bash", count: 2 }]);
});

test("upsertToolCallGroup: description creates distinct key from bare name", () => {
  const initial = upsertToolCallGroup([], "bash");
  const result = upsertToolCallGroup(initial, "bash", "Run tests");
  expect(result).toHaveLength(2);
  expect(result[0]).toEqual({ key: "bash", label: "bash", count: 1 });
  expect(result[1]).toEqual({
    key: "bash\0Run tests",
    label: "bash — Run tests",
    count: 1,
  });
});

test("upsertToolCallGroup: same description groups together", () => {
  const g0 = upsertToolCallGroup([], "bash", "List files");
  const g1 = upsertToolCallGroup(g0, "bash", "List files");
  expect(g1).toHaveLength(1);
  expect(g1[0]?.count).toBe(2);
});

test("upsertToolCallGroup: preserves order of existing groups", () => {
  const g0 = upsertToolCallGroup([], "read_file");
  const g1 = upsertToolCallGroup(g0, "glob");
  const g2 = upsertToolCallGroup(g1, "read_file");
  expect(g2.map((g) => g.key)).toEqual(["read_file", "glob"]);
  expect(g2[0]?.count).toBe(2);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
bun test src/tests/channels/tool-block.test.ts
```

Expected: `Cannot find module '../../channels/tool-block'`

- [ ] **Step 3: Create the tool-block module**

```typescript
// src/channels/tool-block.ts
export interface ToolCallGroup {
  key: string;
  label: string;
  count: number;
}

export function makeToolCallKey(
  toolName: string,
  description?: string,
): string {
  return description ? `${toolName}\0${description}` : toolName;
}

export function makeToolCallLabel(
  toolName: string,
  description?: string,
): string {
  return description ? `${toolName} — ${description}` : toolName;
}

export function renderToolBlock(groups: ToolCallGroup[]): string {
  const lines = groups.map((g) =>
    g.count === 1 ? `• ${g.label}` : `• ${g.label} ×${g.count}`,
  );
  return `🔧 Tools used:\n${lines.join("\n")}`;
}

export function upsertToolCallGroup(
  groups: ToolCallGroup[],
  toolName: string,
  description?: string,
): ToolCallGroup[] {
  const key = makeToolCallKey(toolName, description);
  const idx = groups.findIndex((g) => g.key === key);
  if (idx !== -1) {
    return groups.map((g, i) =>
      i === idx ? { ...g, count: g.count + 1 } : g,
    );
  }
  return [
    ...groups,
    { key, label: makeToolCallLabel(toolName, description), count: 1 },
  ];
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/tests/channels/tool-block.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/tool-block.ts src/tests/channels/tool-block.test.ts
git commit -m "feat: add tool-block module with renderToolBlock and upsertToolCallGroup"
```

---

## Task 2: Extend ChannelTurnLifecycleEvent with the tool_call variant

**Files:**
- Modify: `src/channels/types.ts:84-100`

- [ ] **Step 1: Add the new variant**

In `src/channels/types.ts`, the `ChannelTurnLifecycleEvent` type currently ends at line 100. Add the `tool_call` variant:

```typescript
// Before (lines 84–100):
export type ChannelTurnLifecycleEvent =
  | {
      type: "queued";
      source: ChannelTurnSource;
    }
  | {
      type: "processing";
      batchId: string;
      sources: ChannelTurnSource[];
    }
  | {
      type: "finished";
      batchId: string;
      sources: ChannelTurnSource[];
      outcome: ChannelTurnOutcome;
      error?: string;
    };

// After:
export type ChannelTurnLifecycleEvent =
  | {
      type: "queued";
      source: ChannelTurnSource;
    }
  | {
      type: "processing";
      batchId: string;
      sources: ChannelTurnSource[];
    }
  | {
      type: "tool_call";
      batchId: string;
      toolName: string;
      description?: string;
      sources: ChannelTurnSource[];
    }
  | {
      type: "finished";
      batchId: string;
      sources: ChannelTurnSource[];
      outcome: ChannelTurnOutcome;
      error?: string;
    };
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
bun run tsc --noEmit 2>&1 | head -30
```

Expected: no new errors. Slack and Discord's `handleTurnLifecycleEvent` implementations have no branch for `"tool_call"` so they silently ignore it — no changes needed there.

- [ ] **Step 3: Commit**

```bash
git add src/channels/types.ts
git commit -m "feat(channels): add tool_call variant to ChannelTurnLifecycleEvent"
```

---

## Task 3: Add onToolCall option to executeTool and dispatch it

**Files:**
- Modify: `src/tools/manager.ts:1526-1535` (options block) and `~1673` (before `tool.fn` call)

- [ ] **Step 1: Add the option to executeTool's options type**

In `src/tools/manager.ts`, the `executeTool` options block is at lines 1526–1535. Add `onToolCall?` as the last option:

```typescript
// Find this block (lines 1526-1535):
  options?: {
    signal?: AbortSignal;
    toolCallId?: string;
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
    toolContextId?: string;
    parentScope?: { agentId: string; conversationId: string };
    /** Called after a file-mutating tool (Edit, Write, MultiEdit) writes to disk.
     *  The listener layer uses this to broadcast the new content via WebSocket. */
    onFileWrite?: (filePath: string, content: string) => void;
  },

// Replace with:
  options?: {
    signal?: AbortSignal;
    toolCallId?: string;
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
    toolContextId?: string;
    parentScope?: { agentId: string; conversationId: string };
    /** Called after a file-mutating tool (Edit, Write, MultiEdit) writes to disk.
     *  The listener layer uses this to broadcast the new content via WebSocket. */
    onFileWrite?: (filePath: string, content: string) => void;
    /** Called just before each tool runs. Used by channel adapters to show tool activity. */
    onToolCall?: (toolName: string, description?: string) => void;
  },
```

- [ ] **Step 2: Call the callback just before tool.fn executes**

Find line 1674 (`const result = await tool.fn(enhancedArgs);`) and insert the callback call just before it:

```typescript
// Add these two lines immediately before `const result = await tool.fn(enhancedArgs);`:
options?.onToolCall?.(
  internalName,
  typeof (args as Record<string, unknown>).description === "string"
    ? ((args as Record<string, unknown>).description as string)
    : undefined,
);

const result = await tool.fn(enhancedArgs);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/tools/manager.ts
git commit -m "feat(tools): add onToolCall option to executeTool, fired before each tool runs"
```

---

## Task 4: Thread onToolCall through the approval execution pipeline

**Files:**
- Modify: `src/agent/approval-execution.ts` (lines 191–271 for `executeSingleDecision`, lines 368–507 for `executeApprovalBatch`)

- [ ] **Step 1: Add onToolCall to executeSingleDecision options**

The `executeSingleDecision` function signature at line 191:

```typescript
// Find this options block inside executeSingleDecision (lines 193-205):
  options?: {
    abortSignal?: AbortSignal;
    onStreamingOutput?: (
      toolCallId: string,
      chunk: string,
      isStderr?: boolean,
    ) => void;
    toolContextId?: string;
    parentScope?: { agentId: string; conversationId: string };
    onFileWrite?: (filePath: string, content: string) => void;
  },

// Replace with:
  options?: {
    abortSignal?: AbortSignal;
    onStreamingOutput?: (
      toolCallId: string,
      chunk: string,
      isStderr?: boolean,
    ) => void;
    toolContextId?: string;
    parentScope?: { agentId: string; conversationId: string };
    onFileWrite?: (filePath: string, content: string) => void;
    onToolCall?: (toolName: string, description?: string) => void;
  },
```

- [ ] **Step 2: Pass onToolCall into executeTool inside executeSingleDecision**

The `executeTool` call is at line 255. Find the options object passed to it and add `onToolCall`:

```typescript
// Find the executeTool call (around line 255-272):
      const toolResult = await executeTool(
        decision.approval.toolName,
        parsedArgs,
        {
          signal: options?.abortSignal,
          toolCallId: decision.approval.toolCallId,
          toolContextId: options?.toolContextId,
          parentScope: options?.parentScope,
          onOutput: options?.onStreamingOutput
            ? (chunk, stream) =>
                options.onStreamingOutput?.(
                  decision.approval.toolCallId,
                  chunk,
                  stream === "stderr",
                )
            : undefined,
          onFileWrite: options?.onFileWrite,
        },
      );

// Replace with:
      const toolResult = await executeTool(
        decision.approval.toolName,
        parsedArgs,
        {
          signal: options?.abortSignal,
          toolCallId: decision.approval.toolCallId,
          toolContextId: options?.toolContextId,
          parentScope: options?.parentScope,
          onOutput: options?.onStreamingOutput
            ? (chunk, stream) =>
                options.onStreamingOutput?.(
                  decision.approval.toolCallId,
                  chunk,
                  stream === "stderr",
                )
            : undefined,
          onFileWrite: options?.onFileWrite,
          onToolCall: options?.onToolCall,
        },
      );
```

- [ ] **Step 3: Add onToolCall to executeApprovalBatch options**

The `executeApprovalBatch` function options at line 371:

```typescript
// Find this options block inside executeApprovalBatch (lines 371-382):
  options?: {
    abortSignal?: AbortSignal;
    onStreamingOutput?: (
      toolCallId: string,
      chunk: string,
      isStderr?: boolean,
    ) => void;
    toolContextId?: string;
    workingDirectory?: string;
    parentScope?: { agentId: string; conversationId: string };
    onFileWrite?: (filePath: string, content: string) => void;
  },

// Replace with:
  options?: {
    abortSignal?: AbortSignal;
    onStreamingOutput?: (
      toolCallId: string,
      chunk: string,
      isStderr?: boolean,
    ) => void;
    toolContextId?: string;
    workingDirectory?: string;
    parentScope?: { agentId: string; conversationId: string };
    onFileWrite?: (filePath: string, content: string) => void;
    onToolCall?: (toolName: string, description?: string) => void;
  },
```

- [ ] **Step 4: Pass onToolCall into executeSingleDecision inside executeApprovalBatch**

The `executeSingleDecision` call is at line 447. Find the options object and add `onToolCall`:

```typescript
// Find the executeSingleDecision call (around line 447-455):
      results[i] = await executeSingleDecision(decision, onChunk, {
        abortSignal: options?.abortSignal,
        onStreamingOutput: options?.onStreamingOutput,
        toolContextId,
        parentScope: options?.parentScope,
        onFileWrite: options?.onFileWrite,
      });

// Replace with:
      results[i] = await executeSingleDecision(decision, onChunk, {
        abortSignal: options?.abortSignal,
        onStreamingOutput: options?.onStreamingOutput,
        toolContextId,
        parentScope: options?.parentScope,
        onFileWrite: options?.onFileWrite,
        onToolCall: options?.onToolCall,
      });
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/agent/approval-execution.ts
git commit -m "feat(agent): thread onToolCall option through approval execution pipeline"
```

---

## Task 5: Wire the onToolCall dispatch in turn-approval.ts

**Files:**
- Modify: `src/websocket/listener/turn-approval.ts` (~line 499)

`turn-approval.ts` already imports `getChannelRegistry` from `../../channels/registry` (line 13) and has access to `runtime.activeChannelTurnSources` and `dequeuedBatchId` — no new imports needed.

- [ ] **Step 1: Construct the onToolCall callback and pass it to executeApprovalBatch**

Find the `executeApprovalBatch` call at line 499. Add the `onToolCall` callback just before it:

```typescript
// Find this block (lines 499-507):
  const executionResults = await executeApprovalBatch(decisions, undefined, {
    toolContextId: turnToolContextId ?? undefined,
    abortSignal: abortController.signal,
    onStreamingOutput: emitToolExecutionOutput,
    workingDirectory: turnWorkingDirectory,
    parentScope:
      agentId && conversationId ? { agentId, conversationId } : undefined,
    onFileWrite,
  });

// Replace with:
  const channelSources = runtime.activeChannelTurnSources ?? [];
  const onToolCall =
    channelSources.length > 0
      ? (toolName: string, description?: string) => {
          const registry = getChannelRegistry();
          if (!registry) return;
          void registry.dispatchTurnLifecycleEvent({
            type: "tool_call",
            batchId: dequeuedBatchId,
            toolName,
            description,
            sources: channelSources,
          });
        }
      : undefined;

  const executionResults = await executeApprovalBatch(decisions, undefined, {
    toolContextId: turnToolContextId ?? undefined,
    abortSignal: abortController.signal,
    onStreamingOutput: emitToolExecutionOutput,
    workingDirectory: turnWorkingDirectory,
    parentScope:
      agentId && conversationId ? { agentId, conversationId } : undefined,
    onFileWrite,
    onToolCall,
  });
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/websocket/listener/turn-approval.ts
git commit -m "feat(listener): dispatch tool_call lifecycle event when channel sources are active"
```

---

## Task 6: Write failing tests for the Telegram adapter lifecycle events

**Files:**
- Modify: `src/tests/channels/telegram-adapter.test.ts`

The existing `FakeBot.api` mock object needs `sendChatAction`. Add it alongside the existing mocks in the `FakeBot` class.

- [ ] **Step 1: Add sendChatAction to FakeBot.api**

In `src/tests/channels/telegram-adapter.test.ts`, find the `FakeBot.api` object (lines 51–63) and add:

```typescript
// Find this section in FakeBot.api:
  readonly api = {
    sendMessage: mock(async () => ({ message_id: 999 })),
    setMessageReaction: mock(async () => true),
    sendPhoto: mock(async () => ({ message_id: 1001 })),
    sendDocument: mock(async () => ({ message_id: 1002 })),
    sendVideo: mock(async () => ({ message_id: 1003 })),
    sendAudio: mock(async () => ({ message_id: 1004 })),
    sendVoice: mock(async () => ({ message_id: 1005 })),
    sendAnimation: mock(async () => ({ message_id: 1006 })),
    getFile: mock(async (fileId: string) => FakeBot.nextGetFileImpl(fileId)),
    answerCallbackQuery: mock(async () => true),
    editMessageText: mock(async () => ({ message_id: 999 })),
  };

// Replace with:
  readonly api = {
    sendMessage: mock(async () => ({ message_id: 999 })),
    setMessageReaction: mock(async () => true),
    sendPhoto: mock(async () => ({ message_id: 1001 })),
    sendDocument: mock(async () => ({ message_id: 1002 })),
    sendVideo: mock(async () => ({ message_id: 1003 })),
    sendAudio: mock(async () => ({ message_id: 1004 })),
    sendVoice: mock(async () => ({ message_id: 1005 })),
    sendAnimation: mock(async () => ({ message_id: 1006 })),
    getFile: mock(async (fileId: string) => FakeBot.nextGetFileImpl(fileId)),
    answerCallbackQuery: mock(async () => true),
    editMessageText: mock(async () => ({ message_id: 999 })),
    sendChatAction: mock(async () => true),
  };
```

Also add `sendChatAction.mockClear()` in the `afterEach` mock-clear block if one exists, or note that `mock.restore()` in `afterAll` handles it.

- [ ] **Step 2: Write the failing lifecycle event tests**

Append these tests to `src/tests/channels/telegram-adapter.test.ts`:

```typescript
// ── Lifecycle event tests ─────────────────────────────────────────────────────

const LIFECYCLE_ACCOUNT = {
  ...telegramAccountDefaults,
  token: "lifecycle-token",
  dmPolicy: "all" as const,
};

const LIFECYCLE_SOURCE = {
  channel: "telegram" as const,
  accountId: "telegram-test-account",
  chatId: "chat-42",
  agentId: "agent-1",
  conversationId: "conv-1",
};

test("typing indicator: sendChatAction called on queued event", async () => {
  const adapter = await createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "queued",
    source: LIFECYCLE_SOURCE,
  });

  expect(bot.api.sendChatAction).toHaveBeenCalledWith("chat-42", "typing");
  await adapter.stop();
});

test("typing indicator: idempotent — second queued for same chat does not double-start", async () => {
  const adapter = await createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({ type: "queued", source: LIFECYCLE_SOURCE });
  const callsAfterFirst = bot.api.sendChatAction.mock.calls.length;
  await adapter.handleTurnLifecycleEvent!({ type: "queued", source: LIFECYCLE_SOURCE });

  expect(bot.api.sendChatAction.mock.calls.length).toBe(callsAfterFirst);
  await adapter.stop();
});

test("typing indicator: processing event starts interval for new chats", async () => {
  const adapter = await createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;
  const newSource = { ...LIFECYCLE_SOURCE, chatId: "chat-99" };

  await adapter.handleTurnLifecycleEvent!({
    type: "processing",
    batchId: "batch-1",
    sources: [newSource],
  });

  expect(bot.api.sendChatAction).toHaveBeenCalledWith("chat-99", "typing");
  await adapter.stop();
});

test("tool block: first tool_call sends a new message", async () => {
  const adapter = await createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [LIFECYCLE_SOURCE],
  });

  expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  const [chatId, text] = bot.api.sendMessage.mock.calls[0]!;
  expect(chatId).toBe("chat-42");
  expect(text).toBe("🔧 Tools used:\n• read_file");
  await adapter.stop();
});

test("tool block: second tool_call edits the existing message", async () => {
  const adapter = await createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [LIFECYCLE_SOURCE],
  });
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [LIFECYCLE_SOURCE],
  });

  expect(bot.api.sendMessage).toHaveBeenCalledTimes(1); // no second send
  expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
  const [chatId, _msgId, text] = bot.api.editMessageText.mock.calls[0]!;
  expect(chatId).toBe("chat-42");
  expect(text).toBe("🔧 Tools used:\n• read_file ×2");
  await adapter.stop();
});

test("tool block: tool with description grouped correctly", async () => {
  const adapter = await createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    description: "Run tests",
    sources: [LIFECYCLE_SOURCE],
  });
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    description: "Run tests",
    sources: [LIFECYCLE_SOURCE],
  });

  const [, _msgId, text] = bot.api.editMessageText.mock.calls[0]!;
  expect(text).toBe("🔧 Tools used:\n• bash — Run tests ×2");
  await adapter.stop();
});

test("tool block: exceeding 3800 chars sends new message and resets state", async () => {
  const adapter = await createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  // First tool call — creates the block
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    sources: [LIFECYCLE_SOURCE],
  });

  // Manufacture an oversized state by sending many tools
  // Build enough calls to push text > 3800 chars
  // Each "• bash — <long description>" is ~40 chars; 100 distinct descriptions = ~4000 chars
  for (let i = 0; i < 100; i++) {
    await adapter.handleTurnLifecycleEvent!({
      type: "tool_call",
      batchId: "batch-1",
      toolName: "bash",
      description: `A very long description that makes things large number ${i}`,
      sources: [LIFECYCLE_SOURCE],
    });
  }

  // sendMessage should have been called more than once (overflow triggered)
  expect(bot.api.sendMessage.mock.calls.length).toBeGreaterThan(1);
  await adapter.stop();
});

test("tool block: cleared on finished (state does not persist)", async () => {
  const adapter = await createTelegramAdapter(LIFECYCLE_ACCOUNT);
  await adapter.start();
  const bot = FakeBot.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [LIFECYCLE_SOURCE],
  });
  const sendCallsBefore = bot.api.sendMessage.mock.calls.length;

  await adapter.handleTurnLifecycleEvent!({
    type: "finished",
    batchId: "batch-1",
    sources: [LIFECYCLE_SOURCE],
    outcome: "completed",
  });

  // A new turn starts — tool_call should create a fresh message, not edit
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-2",
    toolName: "glob",
    sources: [LIFECYCLE_SOURCE],
  });

  expect(bot.api.sendMessage.mock.calls.length).toBe(sendCallsBefore + 1);
  expect(bot.api.editMessageText.mock.calls.length).toBe(0);
  await adapter.stop();
});
```

- [ ] **Step 3: Run to confirm tests fail**

```bash
bun test src/tests/channels/telegram-adapter.test.ts 2>&1 | tail -20
```

Expected: tests fail with `adapter.handleTurnLifecycleEvent is not a function` or similar.

---

## Task 7: Implement handleTurnLifecycleEvent in the Telegram adapter

**Files:**
- Modify: `src/channels/telegram/adapter.ts`

- [ ] **Step 1: Import the tool-block helpers**

At the top of `src/channels/telegram/adapter.ts`, add the import alongside existing channel imports:

```typescript
import {
  renderToolBlock,
  upsertToolCallGroup,
  type ToolCallGroup,
} from "../tool-block";
```

- [ ] **Step 2: Add state maps to the adapter closure**

Inside `createTelegramAdapter`, right after the existing state declarations (after `let running = false;` near line 215), add:

```typescript
const typingIntervalByChatId = new Map<string, ReturnType<typeof setInterval>>();

interface ToolBlockState {
  messageId: number;
  groups: ToolCallGroup[];
}
const toolBlockStateByChatId = new Map<string, ToolBlockState>();
const toolBlockOperationByChatId = new Map<string, Promise<void>>();
```

- [ ] **Step 3: Add the startTypingInterval helper**

Add this function inside the closure, before the returned adapter object:

```typescript
function startTypingInterval(chatId: string): void {
  if (typingIntervalByChatId.has(chatId) || !bot) return;
  const fire = () => {
    if (!bot) return;
    void bot.api.sendChatAction(chatId, "typing").catch(() => {});
  };
  fire();
  typingIntervalByChatId.set(chatId, setInterval(fire, 4000));
}

function stopTypingInterval(chatId: string): void {
  const timer = typingIntervalByChatId.get(chatId);
  if (timer !== undefined) {
    clearInterval(timer);
    typingIntervalByChatId.delete(chatId);
  }
}
```

- [ ] **Step 4: Add the scheduleToolBlockUpdate helper**

Add this function inside the closure, after `stopTypingInterval`:

```typescript
function scheduleToolBlockUpdate(
  chatId: string,
  toolName: string,
  description?: string,
): void {
  const previous =
    toolBlockOperationByChatId.get(chatId) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      if (!bot) return;
      const state = toolBlockStateByChatId.get(chatId);
      const newGroups = upsertToolCallGroup(
        state?.groups ?? [],
        toolName,
        description,
      );
      const text = renderToolBlock(newGroups);

      if (!state) {
        const result = await bot.api.sendMessage(chatId, text);
        toolBlockStateByChatId.set(chatId, {
          messageId: result.message_id,
          groups: newGroups,
        });
      } else if (text.length > 3800) {
        const freshGroups = upsertToolCallGroup([], toolName, description);
        const freshText = renderToolBlock(freshGroups);
        const result = await bot.api.sendMessage(chatId, freshText);
        toolBlockStateByChatId.set(chatId, {
          messageId: result.message_id,
          groups: freshGroups,
        });
      } else {
        await bot.api
          .editMessageText(chatId, state.messageId, text)
          .catch(() => {});
        toolBlockStateByChatId.set(chatId, { ...state, groups: newGroups });
      }
    })
    .catch((error) => {
      console.warn(
        `[Telegram] Failed to update tool block for ${chatId}:`,
        error instanceof Error ? error.message : error,
      );
    })
    .finally(() => {
      if (toolBlockOperationByChatId.get(chatId) === operation) {
        toolBlockOperationByChatId.delete(chatId);
      }
    });
  toolBlockOperationByChatId.set(chatId, operation);
}
```

- [ ] **Step 5: Add handleTurnLifecycleEvent to the returned adapter object**

Inside the returned adapter object (after `isRunning()` at line 643 and before `sendMessage` at line 646), add:

```typescript
async handleTurnLifecycleEvent(
  event: ChannelTurnLifecycleEvent,
): Promise<void> {
  if (!running) return;

  if (event.type === "queued") {
    startTypingInterval(event.source.chatId);
    return;
  }

  if (event.type === "processing") {
    for (const source of event.sources) {
      startTypingInterval(source.chatId);
    }
    return;
  }

  if (event.type === "tool_call") {
    for (const source of event.sources) {
      scheduleToolBlockUpdate(source.chatId, event.toolName, event.description);
    }
    return;
  }

  // "finished"
  for (const source of event.sources) {
    stopTypingInterval(source.chatId);
    toolBlockStateByChatId.delete(source.chatId);
    toolBlockOperationByChatId.delete(source.chatId);
  }
},
```

You'll also need to import `ChannelTurnLifecycleEvent` — check if it's already imported from `../types`. If not, add it to the existing import.

- [ ] **Step 6: Clear state in stop()**

In the `stop()` method (line 628), add cleanup before the existing `bufferedMediaGroups.clear()` line:

```typescript
async stop(): Promise<void> {
  for (const timer of typingIntervalByChatId.values()) {
    clearInterval(timer);
  }
  typingIntervalByChatId.clear();
  toolBlockStateByChatId.clear();
  toolBlockOperationByChatId.clear();

  for (const entry of bufferedMediaGroups.values()) {
    clearTimeout(entry.timer);
  }
  // ... rest of existing stop() code unchanged
```

- [ ] **Step 7: Run the Telegram tests**

```bash
bun test src/tests/channels/telegram-adapter.test.ts 2>&1 | tail -30
```

Expected: all new lifecycle tests pass. Existing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add src/channels/telegram/adapter.ts src/tests/channels/telegram-adapter.test.ts
git commit -m "feat(telegram): implement handleTurnLifecycleEvent with typing indicators and tool call block"
```

---

## Task 8: Write failing tests for the Matrix adapter lifecycle events

**Files:**
- Modify: `src/tests/channels/matrix-adapter.test.ts`

The existing `FakeMatrixClient` needs `sendTyping`. Add it alongside the existing mocks.

- [ ] **Step 1: Add sendTyping to FakeMatrixClient**

In `src/tests/channels/matrix-adapter.test.ts`, find the `FakeMatrixClient` class (starting line 19) and add `sendTyping` alongside the existing mocks:

```typescript
// Add after redactEvent mock (around line 38):
sendTyping = mock(async (_roomId: string, _isTyping: boolean, _timeout?: number) => {});
```

- [ ] **Step 2: Write the failing lifecycle event tests**

Append these tests to `src/tests/channels/matrix-adapter.test.ts`:

```typescript
// ── Lifecycle event tests ─────────────────────────────────────────────────────

const MATRIX_LIFECYCLE_ACCOUNT = {
  channel: "matrix" as const,
  accountId: "matrix-lifecycle-account",
  homeserverUrl: "https://matrix.example.org",
  accessToken: "lifecycle-token",
  userId: "@bot:matrix.example.org",
  displayName: "@bot:matrix.example.org",
  binding: { agentId: null, conversationId: null },
  createdAt: "2026-04-23T00:00:00.000Z",
  updatedAt: "2026-04-23T00:00:00.000Z",
};

const MATRIX_LIFECYCLE_SOURCE = {
  channel: "matrix" as const,
  accountId: "matrix-lifecycle-account",
  chatId: "!room-abc:matrix.example.org",
  agentId: "agent-1",
  conversationId: "conv-1",
};

test("Matrix typing indicator: sendTyping(true) called on queued event", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = await createMatrixAdapter(MATRIX_LIFECYCLE_ACCOUNT);
  await adapter.start();
  const client = FakeMatrixClient.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "queued",
    source: MATRIX_LIFECYCLE_SOURCE,
  });

  expect(client.sendTyping).toHaveBeenCalledWith(
    "!room-abc:matrix.example.org",
    true,
    8000,
  );
  await adapter.stop();
});

test("Matrix typing indicator: sendTyping(false) called on finished event", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = await createMatrixAdapter(MATRIX_LIFECYCLE_ACCOUNT);
  await adapter.start();
  const client = FakeMatrixClient.instances.at(-1)!;

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

  expect(client.sendTyping).toHaveBeenLastCalledWith(
    "!room-abc:matrix.example.org",
    false,
  );
  await adapter.stop();
});

test("Matrix tool block: first tool_call sends a new message", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = await createMatrixAdapter(MATRIX_LIFECYCLE_ACCOUNT);
  await adapter.start();
  const client = FakeMatrixClient.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [roomId, content] = client.sendMessage.mock.calls[0]!;
  expect(roomId).toBe("!room-abc:matrix.example.org");
  expect((content as Record<string, unknown>).body).toBe(
    "🔧 Tools used:\n• read_file",
  );
});

test("Matrix tool block: second tool_call edits via m.replace", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = await createMatrixAdapter(MATRIX_LIFECYCLE_ACCOUNT);
  await adapter.start();
  const client = FakeMatrixClient.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "glob",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  expect(client.sendMessage).toHaveBeenCalledTimes(2);
  const [, editContent] = client.sendMessage.mock.calls[1]!;
  const edit = editContent as Record<string, unknown>;
  expect((edit["m.relates_to"] as Record<string, unknown>)?.["rel_type"]).toBe(
    "m.replace",
  );
  expect((edit["m.new_content"] as Record<string, unknown>)?.["body"]).toBe(
    "🔧 Tools used:\n• read_file\n• glob",
  );
  await adapter.stop();
});

test("Matrix tool block: no size guard — block grows indefinitely", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = await createMatrixAdapter(MATRIX_LIFECYCLE_ACCOUNT);
  await adapter.start();
  const client = FakeMatrixClient.instances.at(-1)!;

  for (let i = 0; i < 150; i++) {
    await adapter.handleTurnLifecycleEvent!({
      type: "tool_call",
      batchId: "batch-1",
      toolName: "bash",
      description: `A very long description that makes things large number ${i}`,
      sources: [MATRIX_LIFECYCLE_SOURCE],
    });
  }

  // All 150 distinct tools: 1 sendMessage (create) + 149 edits = 150 total calls
  // but we only need to verify no extra "create" was issued
  const firstCall = client.sendMessage.mock.calls[0]!;
  const [, firstContent] = firstCall;
  // first call has no m.relates_to
  expect(
    (firstContent as Record<string, unknown>)["m.relates_to"],
  ).toBeUndefined();

  // All subsequent calls are edits (have m.relates_to)
  for (let i = 1; i < client.sendMessage.mock.calls.length; i++) {
    const [, content] = client.sendMessage.mock.calls[i]!;
    expect(
      (content as Record<string, unknown>)["m.relates_to"],
    ).toBeDefined();
  }
  await adapter.stop();
});

test("Matrix tool block: cleared on finished", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = await createMatrixAdapter(MATRIX_LIFECYCLE_ACCOUNT);
  await adapter.start();
  const client = FakeMatrixClient.instances.at(-1)!;

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await adapter.handleTurnLifecycleEvent!({
    type: "finished",
    batchId: "batch-1",
    sources: [MATRIX_LIFECYCLE_SOURCE],
    outcome: "completed",
  });

  const countBefore = client.sendMessage.mock.calls.length;

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-2",
    toolName: "glob",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  // Should be a new send (no m.relates_to), not an edit
  const newCall = client.sendMessage.mock.calls[countBefore];
  expect(
    (newCall?.[1] as Record<string, unknown>)["m.relates_to"],
  ).toBeUndefined();
  await adapter.stop();
});
```

- [ ] **Step 3: Run to confirm tests fail**

```bash
bun test src/tests/channels/matrix-adapter.test.ts 2>&1 | tail -20
```

Expected: failures indicating `handleTurnLifecycleEvent` is missing and `sendTyping` is not a function.

---

## Task 9: Implement handleTurnLifecycleEvent in the Matrix adapter

**Files:**
- Modify: `src/channels/matrix/adapter.ts`

- [ ] **Step 1: Import the tool-block helpers**

At the top of `src/channels/matrix/adapter.ts`, add:

```typescript
import {
  renderToolBlock,
  upsertToolCallGroup,
  type ToolCallGroup,
} from "../tool-block";
```

- [ ] **Step 2: Add state maps to the adapter closure**

Inside `createMatrixAdapter`, right after `let running = false;` (line 90), add:

```typescript
const typingIntervalByChatId = new Map<string, ReturnType<typeof setInterval>>();

interface MatrixToolBlockState {
  messageId: string;
  groups: ToolCallGroup[];
}
const toolBlockStateByChatId = new Map<string, MatrixToolBlockState>();
const toolBlockOperationByChatId = new Map<string, Promise<void>>();
```

- [ ] **Step 3: Add typing interval helpers**

Add these functions inside the closure, before the returned adapter object:

```typescript
function startTypingInterval(chatId: string): void {
  if (typingIntervalByChatId.has(chatId) || !matrixClient) return;
  const fire = () => {
    if (!matrixClient) return;
    void matrixClient.sendTyping(chatId, true, 8000).catch(() => {});
  };
  fire();
  typingIntervalByChatId.set(chatId, setInterval(fire, 4000));
}

async function stopTypingInterval(chatId: string): Promise<void> {
  const timer = typingIntervalByChatId.get(chatId);
  if (timer !== undefined) {
    clearInterval(timer);
    typingIntervalByChatId.delete(chatId);
  }
  if (matrixClient) {
    await matrixClient.sendTyping(chatId, false).catch(() => {});
  }
}
```

- [ ] **Step 4: Add the scheduleToolBlockUpdate helper**

```typescript
function scheduleToolBlockUpdate(
  chatId: string,
  toolName: string,
  description?: string,
): void {
  const previous =
    toolBlockOperationByChatId.get(chatId) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      const client = await ensureClient();
      const state = toolBlockStateByChatId.get(chatId);
      const newGroups = upsertToolCallGroup(
        state?.groups ?? [],
        toolName,
        description,
      );
      const text = renderToolBlock(newGroups);

      if (!state) {
        const eventId = await client.sendMessage(chatId, {
          msgtype: "m.text",
          body: text,
        });
        toolBlockStateByChatId.set(chatId, {
          messageId: String(eventId),
          groups: newGroups,
        });
      } else {
        await client.sendMessage(chatId, {
          msgtype: "m.text",
          body: `* ${text}`,
          "m.new_content": { msgtype: "m.text", body: text },
          "m.relates_to": {
            rel_type: "m.replace",
            event_id: state.messageId,
          },
        });
        toolBlockStateByChatId.set(chatId, { ...state, groups: newGroups });
      }
    })
    .catch((error) => {
      console.warn(
        `[Matrix] Failed to update tool block for ${chatId}:`,
        error instanceof Error ? error.message : error,
      );
    })
    .finally(() => {
      if (toolBlockOperationByChatId.get(chatId) === operation) {
        toolBlockOperationByChatId.delete(chatId);
      }
    });
  toolBlockOperationByChatId.set(chatId, operation);
}
```

- [ ] **Step 5: Add handleTurnLifecycleEvent to the returned adapter object**

Add it after `isRunning()` (line 287) and before `sendMessage()` (line 290):

```typescript
async handleTurnLifecycleEvent(
  event: ChannelTurnLifecycleEvent,
): Promise<void> {
  if (!running) return;

  if (event.type === "queued") {
    startTypingInterval(event.source.chatId);
    return;
  }

  if (event.type === "processing") {
    for (const source of event.sources) {
      startTypingInterval(source.chatId);
    }
    return;
  }

  if (event.type === "tool_call") {
    for (const source of event.sources) {
      scheduleToolBlockUpdate(source.chatId, event.toolName, event.description);
    }
    return;
  }

  // "finished"
  await Promise.all(
    event.sources.map(async (source) => {
      await stopTypingInterval(source.chatId);
      toolBlockStateByChatId.delete(source.chatId);
      toolBlockOperationByChatId.delete(source.chatId);
    }),
  );
},
```

Import `ChannelTurnLifecycleEvent` from `../types` if not already imported.

- [ ] **Step 6: Clear state in stop()**

In the `stop()` method (line 281), add cleanup:

```typescript
async stop(): Promise<void> {
  for (const [chatId, timer] of typingIntervalByChatId) {
    clearInterval(timer);
    if (matrixClient) {
      await matrixClient.sendTyping(chatId, false).catch(() => {});
    }
  }
  typingIntervalByChatId.clear();
  toolBlockStateByChatId.clear();
  toolBlockOperationByChatId.clear();

  await matrixClient?.stop();
  running = false;
},
```

- [ ] **Step 7: Run the Matrix tests**

```bash
bun test src/tests/channels/matrix-adapter.test.ts 2>&1 | tail -30
```

Expected: all new lifecycle tests pass. Existing tests still pass.

- [ ] **Step 8: Run the full test suite**

```bash
bun test src/tests/channels/ 2>&1 | tail -20
```

Expected: all channel tests pass, including Slack and Discord (which silently ignore `"tool_call"`).

- [ ] **Step 9: Commit**

```bash
git add src/channels/matrix/adapter.ts src/tests/channels/matrix-adapter.test.ts
git commit -m "feat(matrix): implement handleTurnLifecycleEvent with typing indicators and tool call block"
```

---

## Task 10: Final verification

- [ ] **Step 1: Run the full test suite**

```bash
bun test 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 2: TypeScript clean compile**

```bash
bun run tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: final cleanup and verification of typing indicators feature"
```
