# Reasoning Display in Telegram & Matrix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface agent reasoning (chain-of-thought) to users in Telegram (on-demand via button) and Matrix (live-streaming drawer inside a single message).

**Architecture:** Add an optional `handleStreamReasoning` hook to `ChannelAdapter`, dispatch it from the turn listener alongside existing `dispatchStreamText`, and implement platform-specific display in each adapter. Matrix edits a single "Thinking..." message progressively, then merges it with the answer on completion. Telegram accumulates silently and appends a "🧠 Show reasoning" button to each answer.

**Tech Stack:** TypeScript, Bun, grammY (Telegram), matrix-bot-sdk (Matrix), `bun test`

---

## File Map

| File | Change |
|---|---|
| `src/channels/types.ts` | Add `handleStreamReasoning` hook + `showReasoning` config flag |
| `src/channels/registry.ts` | Add `dispatchStreamReasoning` dispatcher |
| `src/websocket/listener/turn.ts` | Add `extractReasoningText` + dispatch reasoning chunks |
| `src/channels/matrix/adapter.ts` | Per-chatId reasoning state, `handleStreamReasoning`, `sendMessage` intercept |
| `src/channels/telegram/adapter.ts` | Per-chatId reasoning accumulation, `sendMessage` button, callback handler |
| `src/tests/channels/matrix-adapter.test.ts` | New reasoning display tests |
| `src/tests/channels/telegram-adapter.test.ts` | New reasoning display tests |

---

## Task 1: Add `handleStreamReasoning` hook and `showReasoning` config to types

**Files:**
- Modify: `src/channels/types.ts`

- [ ] **Step 1: Add `showReasoning` to `ChannelAccountBase`**

In `src/channels/types.ts`, find `interface ChannelAccountBase` (line 290). Add the new field:

```typescript
interface ChannelAccountBase {
  accountId: string;
  displayName?: string;
  enabled: boolean;
  dmPolicy: DmPolicy;
  allowedUsers: string[];
  createdAt: string;
  updatedAt: string;
  /** When false, reasoning display is disabled. Defaults to true. */
  showReasoning?: boolean;
}
```

- [ ] **Step 2: Add `handleStreamReasoning` to `ChannelAdapter`**

In `src/channels/types.ts`, find `handleStreamReset?` (line 182). Add the new hook after it:

```typescript
  /**
   * Optional hook called when the agent emits a reasoning chunk during a turn.
   * Called with each new chunk as it arrives; adapters accumulate their own
   * buffers. Errors thrown here are caught and logged by the dispatcher.
   */
  handleStreamReasoning?(
    chunk: string,
    sources: ChannelTurnSource[],
  ): Promise<void>;
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
bun tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/channels/types.ts
git commit -m "feat(channels): add handleStreamReasoning hook and showReasoning config"
```

---

## Task 2: Add `dispatchStreamReasoning` to the channel registry

**Files:**
- Modify: `src/channels/registry.ts`

- [ ] **Step 1: Add `dispatchStreamReasoning` after `dispatchStreamReset`**

In `src/channels/registry.ts`, find `dispatchStreamReset` (line 400). After its closing brace, add:

```typescript
  async dispatchStreamReasoning(
    chunk: string,
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
      if (!adapter?.handleStreamReasoning) {
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
      const { handleStreamReasoning } = adapter;
      if (!handleStreamReasoning) continue;
      try {
        await handleStreamReasoning(chunk, groupedSources);
      } catch (error) {
        console.error(
          `[Channels] Failed to dispatch reasoning for ${adapter.channelId ?? adapter.id}/${adapter.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
bun tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/channels/registry.ts
git commit -m "feat(channels): add dispatchStreamReasoning to ChannelRegistry"
```

---

## Task 3: Wire reasoning dispatch in the turn listener

**Files:**
- Modify: `src/websocket/listener/turn.ts`

- [ ] **Step 1: Add `extractReasoningText` alongside `extractAssistantText`**

In `src/websocket/listener/turn.ts`, after `extractAssistantText` (line 127), add:

```typescript
export function extractReasoningText(chunk: Record<string, unknown>): string | null {
  if (chunk.message_type !== "reasoning_message") return null;
  const reasoning = chunk.reasoning;
  if (typeof reasoning === "string") return reasoning || null;
  return null;
}
```

- [ ] **Step 2: Dispatch reasoning chunks in the stream processing callback**

In the same file, find this block (lines 727–735):

```typescript
              const textChunk = extractAssistantText(normalizedChunk);
              if (textChunk) {
                accumulatedChannelText += textChunk;
                if (channelSources && channelSources.length > 0) {
                  void getChannelRegistry()?.dispatchStreamText(
                    accumulatedChannelText,
                    channelSources,
                  );
                }
              }
```

Add the reasoning dispatch immediately after it:

```typescript
              const textChunk = extractAssistantText(normalizedChunk);
              if (textChunk) {
                accumulatedChannelText += textChunk;
                if (channelSources && channelSources.length > 0) {
                  void getChannelRegistry()?.dispatchStreamText(
                    accumulatedChannelText,
                    channelSources,
                  );
                }
              }

              const reasoningChunk = extractReasoningText(normalizedChunk);
              if (reasoningChunk && channelSources && channelSources.length > 0) {
                void getChannelRegistry()?.dispatchStreamReasoning(
                  reasoningChunk,
                  channelSources,
                );
              }
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
bun tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/websocket/listener/turn.ts
git commit -m "feat(turn): dispatch reasoning chunks to channel adapters"
```

---

## Task 4: Matrix adapter — reasoning display

**Files:**
- Modify: `src/channels/matrix/adapter.ts`

- [ ] **Step 1: Add `ChannelTurnSource` to the imports**

In `src/channels/matrix/adapter.ts`, find the import from `../types` (lines 11–19). Add `ChannelTurnSource` to it:

```typescript
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelControlRequestKind,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  InboundChannelMessage,
  MatrixChannelAccount,
  OutboundChannelMessage,
} from "../types";
```

- [ ] **Step 2: Add `escapeHtml` helper after `markdownToMatrixHtml`**

In `src/channels/matrix/adapter.ts`, after `markdownToMatrixHtml` (line 40), add:

```typescript
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

- [ ] **Step 3: Add per-chatId reasoning state variables**

In `src/channels/matrix/adapter.ts`, find the `── Tool block state ─` comment block (around line 119). After `toolBlockOperationByChatId`, add:

```typescript
    // ── Reasoning display state ───────────────────────────────────────────────
    const reasoningMessageIdByChatId = new Map<string, string>();
    const reasoningBufferByChatId = new Map<string, string>();
    const reasoningFlushIntervalByChatId = new Map<
      string,
      ReturnType<typeof setInterval>
    >();
```

- [ ] **Step 4: Add reasoning flush helpers**

After the typing-interval helpers (after `stopTypingInterval`, roughly line 145), add:

```typescript
    function startReasoningFlush(chatId: string): void {
      if (reasoningFlushIntervalByChatId.has(chatId)) return;
      let lastFlushed = "";
      const interval = setInterval(async () => {
        const messageId = reasoningMessageIdByChatId.get(chatId);
        const buffer = reasoningBufferByChatId.get(chatId) ?? "";
        if (!messageId || buffer === lastFlushed || !matrixClient) return;
        lastFlushed = buffer;
        const html = `<details><summary>Thinking...</summary>\n${escapeHtml(buffer)}</details>`;
        await matrixClient
          .sendMessage(chatId, {
            msgtype: "m.text",
            body: "* Thinking...",
            format: "org.matrix.custom.html",
            "m.new_content": {
              msgtype: "m.text",
              body: "* Thinking...",
              format: "org.matrix.custom.html",
              formatted_body: html,
            },
            "m.relates_to": { rel_type: "m.replace", event_id: messageId },
          })
          .catch((error) => {
            console.warn(
              "[Matrix] Failed to flush reasoning:",
              error instanceof Error ? error.message : error,
            );
          });
      }, 500);
      reasoningFlushIntervalByChatId.set(chatId, interval);
    }

    function stopReasoningFlush(chatId: string): void {
      const interval = reasoningFlushIntervalByChatId.get(chatId);
      if (interval !== undefined) {
        clearInterval(interval);
        reasoningFlushIntervalByChatId.delete(chatId);
      }
    }

    function clearReasoningState(chatId: string): void {
      stopReasoningFlush(chatId);
      reasoningMessageIdByChatId.delete(chatId);
      reasoningBufferByChatId.delete(chatId);
    }
```

- [ ] **Step 5: Implement `handleStreamReasoning` on the adapter object**

In the adapter object returned by `createMatrixAdapter`, add `handleStreamReasoning` after `handleStreamReset` (if present) or after `handleTurnLifecycleEvent`. Add:

```typescript
    async handleStreamReasoning(
      chunk: string,
      sources: ChannelTurnSource[],
    ): Promise<void> {
      if (account.showReasoning === false) return;
      const client = await ensureClient();

      for (const source of sources) {
        const { chatId } = source;
        reasoningBufferByChatId.set(
          chatId,
          (reasoningBufferByChatId.get(chatId) ?? "") + chunk,
        );

        if (!reasoningMessageIdByChatId.has(chatId)) {
          try {
            const eventId = await client.sendMessage(chatId, {
              msgtype: "m.text",
              body: "Thinking...",
              format: "org.matrix.custom.html",
              formatted_body: "<details><summary>Thinking...</summary></details>",
            });
            reasoningMessageIdByChatId.set(chatId, String(eventId));
            startReasoningFlush(chatId);
          } catch (error) {
            console.warn(
              "[Matrix] Failed to send initial reasoning message:",
              error instanceof Error ? error.message : error,
            );
          }
        }
      }
    },
```

- [ ] **Step 6: Intercept `sendMessage` for combined reasoning + answer**

In `src/channels/matrix/adapter.ts`, inside `sendMessage`, after the media-upload early return (after line 499) and before the plain-text/HTML section (line 502), add:

```typescript
      // Reasoning display — combine drawer + answer into one edited message
      const pendingReasoningMsgId = reasoningMessageIdByChatId.get(msg.chatId);
      if (pendingReasoningMsgId) {
        stopReasoningFlush(msg.chatId);
        const buffer = reasoningBufferByChatId.get(msg.chatId) ?? "";
        const answerHtml =
          msg.parseMode === "HTML"
            ? markdownToMatrixHtml(msg.text ?? "")
            : escapeHtml(msg.text ?? "");
        const html = `<details><summary>Thinking</summary>\n${escapeHtml(buffer)}</details><hr>${answerHtml}`;
        const plainFallback = `Thinking\n---\n${msg.text ?? ""}`;
        await client
          .sendMessage(msg.chatId, {
            msgtype: "m.text",
            body: plainFallback,
            format: "org.matrix.custom.html",
            "m.new_content": {
              msgtype: "m.text",
              body: plainFallback,
              format: "org.matrix.custom.html",
              formatted_body: html,
            },
            "m.relates_to": {
              rel_type: "m.replace",
              event_id: pendingReasoningMsgId,
            },
          })
          .catch((error) => {
            console.error(
              "[Matrix] Failed to write final reasoning+answer message:",
              error instanceof Error ? error.message : error,
            );
          });
        clearReasoningState(msg.chatId);
        return { messageId: pendingReasoningMsgId };
      }
```

- [ ] **Step 7: Clean up reasoning state in `stop()` and `finished` turn event**

In `stop()` (line 439), after `toolBlockOperationByChatId.clear()`, add:

```typescript
      for (const [, timer] of reasoningFlushIntervalByChatId) {
        clearInterval(timer);
      }
      reasoningFlushIntervalByChatId.clear();
      reasoningMessageIdByChatId.clear();
      reasoningBufferByChatId.clear();
```

In `handleTurnLifecycleEvent`, in the `"finished"` branch, after `toolBlockOperationByChatId.delete(source.chatId)`, add:

```typescript
        clearReasoningState(source.chatId);
```

- [ ] **Step 8: Verify TypeScript compiles**

```bash
bun tsc --noEmit
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/channels/matrix/adapter.ts
git commit -m "feat(matrix): show agent reasoning as live-streaming collapsible drawer"
```

---

## Task 5: Telegram adapter — reasoning on demand

**Files:**
- Modify: `src/channels/telegram/adapter.ts`

- [ ] **Step 1: Add `ChannelTurnSource` to the imports**

In `src/channels/telegram/adapter.ts`, find the import from `../types`. Add `ChannelTurnSource`:

```typescript
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  InboundChannelMessage,
  OutboundChannelMessage,
  TelegramChannelAccount,
} from "../types";
```

(Adjust to match the actual existing imports — only add `ChannelTurnSource`.)

- [ ] **Step 2: Add per-chatId reasoning state variables**

In `src/channels/telegram/adapter.ts`, after `awaitingFeedback` (line 243), add:

```typescript
    const pendingReasoningByChatId = new Map<string, string>();
    const reasoningByKey = new Map<string, string>();
```

- [ ] **Step 3: Implement `handleStreamReasoning` on the adapter object**

Add `handleStreamReasoning` to the adapter object (near `handleTurnLifecycleEvent`):

```typescript
    async handleStreamReasoning(
      chunk: string,
      sources: ChannelTurnSource[],
    ): Promise<void> {
      if (config.showReasoning === false) return;
      for (const source of sources) {
        pendingReasoningByChatId.set(
          source.chatId,
          (pendingReasoningByChatId.get(source.chatId) ?? "") + chunk,
        );
      }
    },
```

- [ ] **Step 4: Append reasoning button in `sendMessage`**

In `src/channels/telegram/adapter.ts`, inside `sendMessage`, find the `opts` construction for text messages (lines 871–885):

```typescript
      const opts: Record<string, unknown> = {};
      if (msg.replyToMessageId) {
        opts.reply_parameters = {
          message_id: Number(msg.replyToMessageId),
        };
      }
      if (msg.parseMode) {
        opts.parse_mode = msg.parseMode;
      }

      const result = await telegramBot.api.sendMessage(
        msg.chatId,
        msg.text,
        opts,
      );
      return { messageId: String(result.message_id) };
```

Replace with:

```typescript
      const opts: Record<string, unknown> = {};
      if (msg.replyToMessageId) {
        opts.reply_parameters = {
          message_id: Number(msg.replyToMessageId),
        };
      }
      if (msg.parseMode) {
        opts.parse_mode = msg.parseMode;
      }

      const pendingReasoning = pendingReasoningByChatId.get(msg.chatId);
      if (pendingReasoning) {
        const key = (callbackKeyCounter++).toString(36);
        reasoningByKey.set(key, pendingReasoning);
        pendingReasoningByChatId.delete(msg.chatId);
        opts.reply_markup = {
          inline_keyboard: [
            [
              {
                text: "🧠 Show reasoning",
                callback_data: JSON.stringify({ k: key, a: "show_reasoning" }),
              },
            ],
          ],
        };
      }

      const result = await telegramBot.api.sendMessage(
        msg.chatId,
        msg.text,
        opts,
      );
      return { messageId: String(result.message_id) };
```

- [ ] **Step 5: Handle the `show_reasoning` callback in the callback query handler**

In `src/channels/telegram/adapter.ts`, find the `CallbackPayload` type definition (line 567) and the `const { k, a: action } = payload;` line (line 580).

Update the type to include the new action:

```typescript
      type CallbackPayload =
        | { k: string; a: "approve" | "deny" }
        | { k: string; a: "option"; i: number }
        | { k: string; a: "deny_reason" | "freeform" }
        | { k: string; a: "show_reasoning" };
```

Then add a handler for `show_reasoning` immediately after `const { k, a: action } = payload;` and BEFORE `const buttonEntry = buttonMessages.get(k);`:

```typescript
      const { k, a: action } = payload;

      if (action === "show_reasoning") {
        const reasoning = reasoningByKey.get(k);
        if (!reasoning) return;
        const chatId = String(query.message?.chat.id ?? "");
        const messageId = query.message?.message_id;
        await instance.api
          .sendMessage(chatId, reasoning, {
            ...(messageId ? { reply_parameters: { message_id: messageId } } : {}),
          })
          .catch((error) => {
            console.error(
              "[Telegram] Failed to send reasoning reply:",
              error instanceof Error ? error.message : error,
            );
          });
        return;
      }

      const buttonEntry = buttonMessages.get(k);
      if (!buttonEntry) return;
```

- [ ] **Step 6: Clear pending reasoning on turn `finished` and in `stop()`**

In `src/channels/telegram/adapter.ts`, in `handleTurnLifecycleEvent`, in the `"finished"` branch, after `toolBlockOperationByChatId.delete(source.chatId)`, add:

```typescript
        pendingReasoningByChatId.delete(source.chatId);
```

In `stop()` (line 718), after `awaitingFeedback.clear()`, add:

```typescript
      pendingReasoningByChatId.clear();
      reasoningByKey.clear();
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
bun tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/channels/telegram/adapter.ts
git commit -m "feat(telegram): show agent reasoning via inline 'Show reasoning' button"
```

---

## Task 6: Matrix adapter tests

**Files:**
- Modify: `src/tests/channels/matrix-adapter.test.ts`

- [ ] **Step 1: Write failing test — reasoning message is sent and combined on answer**

Add to `src/tests/channels/matrix-adapter.test.ts`:

```typescript
test("matrix adapter sends reasoning drawer and combines with answer in single message", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = FakeMatrixClient.instances[0];

  // Simulate first reasoning chunk — adapter sends initial "Thinking..." message
  await adapter.handleStreamReasoning!("I need to search for this.", [
    {
      channel: "matrix" as const,
      accountId: "acc1",
      chatId: "!room1:example.com",
      agentId: "agent1",
      conversationId: "conv1",
    },
  ]);

  // Initial "Thinking..." message was sent
  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [, initialContent] = client.sendMessage.mock.calls[0];
  expect((initialContent as Record<string, unknown>).formatted_body).toContain(
    "<details><summary>Thinking...</summary>",
  );

  // Simulate a second chunk
  await adapter.handleStreamReasoning!("Found 3 results.", [
    {
      channel: "matrix" as const,
      accountId: "acc1",
      chatId: "!room1:example.com",
      agentId: "agent1",
      conversationId: "conv1",
    },
  ]);

  client.sendMessage.mockClear();

  // Answer arrives — should edit the reasoning message, not send a new one
  await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Here are the results.",
    parseMode: "HTML",
  });

  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [, finalContent] = client.sendMessage.mock.calls[0];
  const fc = finalContent as Record<string, unknown>;
  expect(fc["m.relates_to"]).toMatchObject({
    rel_type: "m.replace",
    event_id: "$fake-event-id",
  });
  const newContent = fc["m.new_content"] as Record<string, unknown>;
  expect(newContent.formatted_body).toContain("<details><summary>Thinking</summary>");
  expect(newContent.formatted_body).toContain("<hr>");
  expect(newContent.formatted_body).toContain("Here are the results.");
  expect(newContent.formatted_body).toContain("I need to search for this.");

  await adapter.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test-name-pattern "sends reasoning drawer"
```

Expected: FAIL (method does not exist yet, or assertions fail).

- [ ] **Step 3: Run test after Task 4 implementation to verify it passes**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test-name-pattern "sends reasoning drawer"
```

Expected: PASS.

- [ ] **Step 4: Write failing test — no reasoning means normal sendMessage**

```typescript
test("matrix adapter sends message normally when no reasoning was received", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = FakeMatrixClient.instances[0];

  await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Hello.",
  });

  // Should be exactly one sendMessage call with no m.relates_to (no edit)
  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [, content] = client.sendMessage.mock.calls[0];
  expect((content as Record<string, unknown>)["m.relates_to"]).toBeUndefined();

  await adapter.stop();
});
```

- [ ] **Step 5: Run test to verify it passes (should already pass)**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test-name-pattern "sends message normally when no reasoning"
```

Expected: PASS.

- [ ] **Step 6: Write failing test — `showReasoning: false` skips the drawer**

```typescript
test("matrix adapter skips reasoning drawer when showReasoning is false", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = createMatrixAdapter({ ...TEST_ACCOUNT, showReasoning: false });
  await adapter.start();
  const client = FakeMatrixClient.instances[0];

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

  // Answer arrives normally
  await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Hello.",
  });

  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [, content] = client.sendMessage.mock.calls[0];
  expect((content as Record<string, unknown>)["m.relates_to"]).toBeUndefined();

  await adapter.stop();
});
```

- [ ] **Step 7: Run test to verify it passes**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test-name-pattern "skips reasoning drawer when showReasoning"
```

Expected: PASS.

- [ ] **Step 8: Run full Matrix test suite**

```bash
bun test src/tests/channels/matrix-adapter.test.ts
```

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/tests/channels/matrix-adapter.test.ts
git commit -m "test(matrix): reasoning display — drawer send, normal fallback, opt-out"
```

---

## Task 7: Telegram adapter tests

**Files:**
- Modify: `src/tests/channels/telegram-adapter.test.ts`

- [ ] **Step 1: Write failing test — answer gets "Show reasoning" button**

Add to `src/tests/channels/telegram-adapter.test.ts`:

```typescript
test("telegram adapter appends Show reasoning button when reasoning was received", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram" as const,
    token: "test-token",
    dmPolicy: "open" as const,
    allowedUsers: [],
    enabled: true,
    binding: { agentId: null, conversationId: null },
  });
  await adapter.start();
  const bot = FakeBot.instances[0];

  await adapter.handleStreamReasoning!("I need to think.", [
    {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "42",
      agentId: "agent1",
      conversationId: "conv1",
    },
  ]);
  await adapter.handleStreamReasoning!(" Done.", [
    {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "42",
      agentId: "agent1",
      conversationId: "conv1",
    },
  ]);

  await adapter.sendMessage({
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "42",
    text: "Here is the answer.",
  });

  expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  const [, , opts] = bot.api.sendMessage.mock.calls[0];
  const keyboard = (opts as Record<string, unknown>).reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
  expect(keyboard.inline_keyboard[0][0].text).toBe("🧠 Show reasoning");

  const callbackData = JSON.parse(keyboard.inline_keyboard[0][0].callback_data) as {
    k: string;
    a: string;
  };
  expect(callbackData.a).toBe("show_reasoning");

  await adapter.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/tests/channels/telegram-adapter.test.ts --test-name-pattern "appends Show reasoning button"
```

Expected: FAIL.

- [ ] **Step 3: Run test after Task 5 implementation to verify it passes**

```bash
bun test src/tests/channels/telegram-adapter.test.ts --test-name-pattern "appends Show reasoning button"
```

Expected: PASS.

- [ ] **Step 4: Write failing test — tapping the button sends reasoning as reply**

```typescript
test("telegram adapter sends reasoning as reply when Show reasoning button is tapped", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram" as const,
    token: "test-token",
    dmPolicy: "open" as const,
    allowedUsers: [],
    enabled: true,
    binding: { agentId: null, conversationId: null },
  });
  await adapter.start();
  const bot = FakeBot.instances[0];

  await adapter.handleStreamReasoning!("My reasoning.", [
    {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "42",
      agentId: "agent1",
      conversationId: "conv1",
    },
  ]);

  await adapter.sendMessage({
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "42",
    text: "Answer.",
  });

  // Capture callback_data from the sent message
  const [, , sendOpts] = bot.api.sendMessage.mock.calls[0];
  const keyboard = (sendOpts as Record<string, unknown>).reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
  const callbackData = keyboard.inline_keyboard[0][0].callback_data;

  bot.api.sendMessage.mockClear();

  // Simulate user tapping the button
  await bot.emit("callback_query", {
    callbackQuery: {
      id: "cq1",
      from: { id: 7, username: "user" },
      data: callbackData,
      message: { message_id: 999, chat: { id: 42 } },
    },
  });

  expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  const [chatId, text] = bot.api.sendMessage.mock.calls[0];
  expect(chatId).toBe("42");
  expect(text).toBe("My reasoning.");

  await adapter.stop();
});
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test src/tests/channels/telegram-adapter.test.ts --test-name-pattern "sends reasoning as reply"
```

Expected: PASS.

- [ ] **Step 6: Write test — no reasoning means no button**

```typescript
test("telegram adapter sends message without button when no reasoning received", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram" as const,
    token: "test-token",
    dmPolicy: "open" as const,
    allowedUsers: [],
    enabled: true,
    binding: { agentId: null, conversationId: null },
  });
  await adapter.start();
  const bot = FakeBot.instances[0];

  await adapter.sendMessage({
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "42",
    text: "No reasoning here.",
  });

  const [, , opts] = bot.api.sendMessage.mock.calls[0];
  expect((opts as Record<string, unknown>).reply_markup).toBeUndefined();

  await adapter.stop();
});
```

- [ ] **Step 7: Write test — `showReasoning: false` skips button**

```typescript
test("telegram adapter skips reasoning button when showReasoning is false", async () => {
  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram" as const,
    token: "test-token",
    dmPolicy: "open" as const,
    allowedUsers: [],
    enabled: true,
    showReasoning: false,
    binding: { agentId: null, conversationId: null },
  });
  await adapter.start();
  const bot = FakeBot.instances[0];

  await adapter.handleStreamReasoning!("thinking...", [
    {
      channel: "telegram" as const,
      accountId: "telegram-test-account",
      chatId: "42",
      agentId: "agent1",
      conversationId: "conv1",
    },
  ]);

  await adapter.sendMessage({
    channel: "telegram",
    accountId: "telegram-test-account",
    chatId: "42",
    text: "Answer.",
  });

  const [, , opts] = bot.api.sendMessage.mock.calls[0];
  expect((opts as Record<string, unknown>).reply_markup).toBeUndefined();

  await adapter.stop();
});
```

- [ ] **Step 8: Run full Telegram test suite**

```bash
bun test src/tests/channels/telegram-adapter.test.ts
```

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/tests/channels/telegram-adapter.test.ts
git commit -m "test(telegram): reasoning display — button append, tap delivery, opt-out"
```

---

## Final verification

- [ ] **Run full test suite**

```bash
bun test src/tests/channels/
```

Expected: all tests PASS.

- [ ] **Run TypeScript check one final time**

```bash
bun tsc --noEmit
```

Expected: no errors.
