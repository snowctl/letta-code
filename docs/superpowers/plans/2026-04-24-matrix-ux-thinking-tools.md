# Matrix UX: Thinking Block Ordering & Tool Block Formatting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Matrix adapter so the thinking block always appears before the tool block, is deleted and folded into the response on reply, and the tool block uses plain newline-separated lines with `(xN)` counts.

**Architecture:** Three touch-points in the Matrix adapter — `scheduleToolBlockUpdate` sends a thinking placeholder before the first tool message; `sendMessage` redacts the thinking placeholder and sends a fresh response with the thinking drawer on top; `handleTurnEvent("finished")` redacts the placeholder on turns with no response. `renderToolBlock` in `tool-block.ts` is updated for formatting.

**Tech Stack:** TypeScript, Bun, `bun test`, matrix-bot-sdk (`redactEvent`, `sendMessage`)

---

### Task 1: Update `renderToolBlock` formatting

**Files:**
- Modify: `src/channels/tool-block.ts:21-27`
- Modify: `src/tests/channels/tool-block.test.ts:13-40`

- [ ] **Step 1: Update the failing tests first**

Replace the four format-checking tests in `src/tests/channels/tool-block.test.ts`:

```typescript
test("renderToolBlock: single tool no description", () => {
  const groups: ToolCallGroup[] = [{ key: "bash", label: "bash", count: 1 }];
  expect(renderToolBlock(groups)).toBe("🔧 Tools used:\nbash");
});

test("renderToolBlock: single tool count > 1", () => {
  const groups: ToolCallGroup[] = [{ key: "bash", label: "bash", count: 3 }];
  expect(renderToolBlock(groups)).toBe("🔧 Tools used:\nbash (x3)");
});

test("renderToolBlock: tool with description", () => {
  const groups: ToolCallGroup[] = [
    { key: "bash\0Run tests", label: "bash — Run tests", count: 2 },
  ];
  expect(renderToolBlock(groups)).toBe("🔧 Tools used:\nbash — Run tests (x2)");
});

test("renderToolBlock: multiple tools preserves order", () => {
  const groups: ToolCallGroup[] = [
    { key: "read_file", label: "read_file", count: 4 },
    { key: "bash\0Run tests", label: "bash — Run tests", count: 1 },
    { key: "glob", label: "glob", count: 2 },
  ];
  expect(renderToolBlock(groups)).toBe(
    "🔧 Tools used:\nread_file (x4)\nbash — Run tests\nglob (x2)",
  );
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/tests/channels/tool-block.test.ts
```

Expected: 4 failures mentioning `•` and `×`.

- [ ] **Step 3: Update `renderToolBlock` in `src/channels/tool-block.ts`**

Replace lines 21–27:

```typescript
export function renderToolBlock(groups: ToolCallGroup[]): string {
  if (groups.length === 0) return "";
  const lines = groups.map((g) =>
    g.count === 1 ? g.label : `${g.label} (x${g.count})`,
  );
  return `🔧 Tools used:\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/tests/channels/tool-block.test.ts
```

Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/tool-block.ts src/tests/channels/tool-block.test.ts
git commit -m "feat(matrix): remove bullet points from tool block, use (xN) count format"
```

---

### Task 2: Send thinking placeholder before first tool block

**Files:**
- Modify: `src/channels/matrix/adapter.ts:228-286` (`scheduleToolBlockUpdate`)
- Modify: `src/tests/channels/matrix-adapter.test.ts:1053-1184`

- [ ] **Step 1: Write failing tests**

Replace the four tool block lifecycle tests in `src/tests/channels/matrix-adapter.test.ts` (the block starting at line 1053, ending at 1184):

```typescript
test("Matrix tool block: first tool_call sends thinking placeholder then tool block", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$thinking-1")
    .mockResolvedValueOnce("$tool-block-1");

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    description: "run ls",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await new Promise((r) => setTimeout(r, 10));

  expect(client.sendMessage).toHaveBeenCalledTimes(2);

  // First call: thinking placeholder (no m.relates_to = new message)
  const [room0, content0] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
  expect(room0).toBe(MATRIX_LIFECYCLE_SOURCE.chatId);
  expect((content0 as Record<string, unknown>).formatted_body as string).toContain(
    "<details><summary>Thinking...</summary>",
  );
  expect((content0 as Record<string, unknown>)["m.relates_to"]).toBeUndefined();

  // Second call: tool block (no m.relates_to = new message)
  const [room1, content1] = client.sendMessage.mock.calls[1] as [string, Record<string, unknown>];
  expect(room1).toBe(MATRIX_LIFECYCLE_SOURCE.chatId);
  expect((content1 as Record<string, unknown>).body).toContain("bash");
  expect((content1 as Record<string, unknown>)["m.relates_to"]).toBeUndefined();
});

test("Matrix tool block: second tool_call edits tool block via m.replace", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$thinking-1")
    .mockResolvedValueOnce("$tool-block-1")
    .mockResolvedValueOnce("$tool-block-edit-1");

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "read_file",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await new Promise((r) => setTimeout(r, 10));

  // 3 calls: thinking placeholder + tool block create + tool block edit
  expect(client.sendMessage).toHaveBeenCalledTimes(3);

  const thirdCall = client.sendMessage.mock.calls[2] as [string, Record<string, unknown>];
  const thirdContent = thirdCall[1];
  const relatesTo = thirdContent["m.relates_to"] as Record<string, unknown> | undefined;
  expect(relatesTo?.rel_type).toBe("m.replace");
  expect(relatesTo?.event_id).toBe("$tool-block-1");

  const newContent = thirdContent["m.new_content"] as Record<string, unknown> | undefined;
  expect(newContent?.body).toContain("bash");
  expect(newContent?.body).toContain("read_file");
});

test("Matrix tool block: no size guard — block grows indefinitely", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValue("$tool-block-main");

  for (let i = 0; i < 150; i++) {
    await adapter.handleTurnLifecycleEvent!({
      type: "tool_call",
      batchId: "batch-1",
      toolName: `tool_${i}`,
      description: `desc ${i}`,
      sources: [MATRIX_LIFECYCLE_SOURCE],
    });
  }

  await new Promise((r) => setTimeout(r, 200));

  const calls = client.sendMessage.mock.calls as Array<[string, Record<string, unknown>]>;
  // calls[0]: thinking placeholder (no m.relates_to)
  expect(calls[0]![1]["m.relates_to"]).toBeUndefined();
  expect((calls[0]![1] as Record<string, unknown>).formatted_body as string).toContain("Thinking...");
  // calls[1]: tool block create (no m.relates_to)
  expect(calls[1]![1]["m.relates_to"]).toBeUndefined();
  // calls[2..150]: tool block edits
  for (let i = 2; i < calls.length; i++) {
    const relatesTo = calls[i]![1]["m.relates_to"] as Record<string, unknown> | undefined;
    expect(relatesTo?.rel_type).toBe("m.replace");
  }
  // 1 thinking placeholder + 1 tool block create + 149 edits = 151
  expect(calls).toHaveLength(151);
});

test("Matrix tool block: cleared on finished, thinking placeholder redacted", async () => {
  const adapter = await makeLifecycleAdapter();
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$thinking-first")
    .mockResolvedValueOnce("$block-first")
    .mockResolvedValueOnce("$thinking-second")
    .mockResolvedValueOnce("$block-second");

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Finish with no response — clears tool block state, redacts thinking placeholder
  await adapter.handleTurnLifecycleEvent!({
    type: "finished",
    batchId: "batch-1",
    sources: [MATRIX_LIFECYCLE_SOURCE],
    outcome: "completed",
  });

  expect(client.redactEvent).toHaveBeenCalledWith(
    MATRIX_LIFECYCLE_SOURCE.chatId,
    "$thinking-first",
  );

  // Second tool_call in a new turn
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-2",
    toolName: "read_file",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Second turn's thinking placeholder is a new message (no m.relates_to)
  const secondThinking = client.sendMessage.mock.calls[2] as [string, Record<string, unknown>];
  expect(secondThinking[1]["m.relates_to"]).toBeUndefined();
  expect((secondThinking[1] as Record<string, unknown>).formatted_body as string).toContain("Thinking...");
  // Second turn's tool block is also a new message
  const secondTool = client.sendMessage.mock.calls[3] as [string, Record<string, unknown>];
  expect(secondTool[1]["m.relates_to"]).toBeUndefined();
});
```

Also add one new test for the `showReasoning: false` case (no placeholder on tool calls):

```typescript
test("Matrix tool block: no thinking placeholder when showReasoning is false", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = createMatrixAdapter({
    ...MATRIX_LIFECYCLE_ACCOUNT,
    showReasoning: false,
  });
  await adapter.start();
  const client = getLifecycleFakeClient();
  client.sendMessage.mockResolvedValueOnce("$tool-block-1");

  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "batch-1",
    toolName: "bash",
    sources: [MATRIX_LIFECYCLE_SOURCE],
  });

  await new Promise((r) => setTimeout(r, 10));

  // Only 1 message (tool block only, no thinking placeholder)
  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [, content] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
  expect((content as Record<string, unknown>).body).toContain("bash");
  expect((content as Record<string, unknown>).formatted_body).toBeUndefined();

  await adapter.stop();
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/tests/channels/matrix-adapter.test.ts 2>&1 | grep -E "FAIL|PASS|tool block"
```

Expected: the four rewritten tool block tests fail (plus the new one).

- [ ] **Step 3: Update `scheduleToolBlockUpdate` in `src/channels/matrix/adapter.ts`**

Replace the entire `scheduleToolBlockUpdate` function (lines 228–286):

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
      if (!matrixClient) return;

      // Send thinking placeholder before tool block to guarantee ordering
      if (account.showReasoning !== false && !reasoningMessageIdByChatId.has(chatId)) {
        reasoningMessageIdByChatId.set(chatId, "__pending__");
        try {
          const eventId = await matrixClient.sendMessage(chatId, {
            msgtype: "m.text",
            body: "Thinking...",
            format: "org.matrix.custom.html",
            formatted_body: "<details><summary>Thinking...</summary></details>",
          });
          reasoningMessageIdByChatId.set(chatId, String(eventId));
          startReasoningFlush(chatId);
        } catch (error) {
          reasoningMessageIdByChatId.delete(chatId);
          console.warn(
            "[Matrix] Failed to send thinking placeholder:",
            error instanceof Error ? error.message : error,
          );
        }
      }

      const state = toolBlockStateByChatId.get(chatId);
      const newGroups = upsertToolCallGroup(
        state?.groups ?? [],
        toolName,
        description,
      );
      const text = renderToolBlock(newGroups);

      if (!state) {
        // Send new message
        const eventId = await matrixClient.sendMessage(chatId, {
          msgtype: "m.text",
          body: text,
        });
        toolBlockStateByChatId.set(chatId, {
          messageId: String(eventId),
          groups: newGroups,
        });
      } else {
        // Edit via m.relates_to / m.replace
        await matrixClient.sendMessage(chatId, {
          msgtype: "m.text",
          body: `* ${text}`,
          "m.new_content": { msgtype: "m.text", body: text },
          "m.relates_to": {
            rel_type: "m.replace",
            event_id: state.messageId,
          },
        });
        toolBlockStateByChatId.set(chatId, {
          messageId: state.messageId,
          groups: newGroups,
        });
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

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/tests/channels/matrix-adapter.test.ts 2>&1 | grep -E "FAIL|PASS|tool block|showReasoning"
```

Expected: the five tool block tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/matrix/adapter.ts src/tests/channels/matrix-adapter.test.ts
git commit -m "feat(matrix): send thinking placeholder before first tool block to guarantee ordering"
```

---

### Task 3: Rewrite `sendMessage` reasoning path (redact + new message)

**Files:**
- Modify: `src/channels/matrix/adapter.ts:598-638`
- Modify: `src/tests/channels/matrix-adapter.test.ts` (replace the three existing reasoning tests)

- [ ] **Step 1: Replace the three existing reasoning tests**

Find the block `// ── Reasoning display tests` (around line 1186) and replace all three tests with:

```typescript
// ── Reasoning display tests ───────────────────────────────────────────────────

test("matrix adapter: reasoning + response redacts thinking and sends new message with drawer", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$thinking-1")
    .mockResolvedValueOnce("$response-1");

  const source = {
    channel: "matrix" as const,
    accountId: "acc1",
    chatId: "!room1:example.com",
    agentId: "agent1",
    conversationId: "conv1",
  };

  // First chunk — adapter sends initial thinking message
  await adapter.handleStreamReasoning!("I need to search for this.", [source]);
  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  // Second chunk (accumulates in buffer)
  await adapter.handleStreamReasoning!(" Found 3 results.", [source]);

  // Answer arrives — redact thinking, send new message with drawer on top
  const result = await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Here are the results.",
    parseMode: "HTML",
  });

  // Thinking message redacted
  expect(client.redactEvent).toHaveBeenCalledWith("!room1:example.com", "$thinking-1");

  // One new sendMessage call for the response
  expect(client.sendMessage).toHaveBeenCalledTimes(2);
  const [, finalContent] = client.sendMessage.mock.calls[1] as [string, Record<string, unknown>];
  const fc = finalContent as Record<string, unknown>;

  // Must NOT be an m.replace edit — it's a brand-new message
  expect(fc["m.relates_to"]).toBeUndefined();

  const html = fc.formatted_body as string;
  expect(html).toContain("<details><summary>Thinking</summary>");
  expect(html).toContain("<hr>");
  expect(html).toContain("Here are the results.");
  expect(html).toContain("I need to search for this.");
  expect(html).toContain("Found 3 results.");

  // Return value is the new response message's ID
  expect(result.messageId).toBe("$response-1");

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
  const [, content] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
  expect((content as Record<string, unknown>)["m.relates_to"]).toBeUndefined();
  expect(client.redactEvent).not.toHaveBeenCalled();

  await adapter.stop();
});

test("matrix adapter skips reasoning drawer when showReasoning is false", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = createMatrixAdapter({ ...TEST_ACCOUNT, showReasoning: false });
  await adapter.start();
  const client = getFakeClient();

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

  await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Hello.",
  });

  expect(client.sendMessage).toHaveBeenCalledTimes(1);
  const [, content] = client.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
  expect((content as Record<string, unknown>)["m.relates_to"]).toBeUndefined();
  expect(client.redactEvent).not.toHaveBeenCalled();

  await adapter.stop();
});

test("matrix adapter: thinking placeholder (from tool call) deleted when response has no reasoning", async () => {
  const adapter = await makeAdapter();
  await adapter.start();
  const client = getFakeClient();
  // thinking placeholder sent by tool call path; response sends a plain message
  client.sendMessage
    .mockResolvedValueOnce("$thinking-placeholder")
    .mockResolvedValueOnce("$plain-response");

  const source = {
    channel: "matrix" as const,
    accountId: "acc1",
    chatId: "!room1:example.com",
    agentId: "agent1",
    conversationId: "conv1",
  };

  // Simulate tool call path having sent the thinking placeholder by setting state directly
  // (we test this via handleTurnLifecycleEvent in a combined scenario)
  // Here we test: reasoning state exists (msgId set, buffer empty) + response arrives
  await adapter.handleStreamReasoning!("", [source]); // empty chunk — claims slot but adds nothing to buffer

  // Manually drain: handleStreamReasoning with "" still sends initial message if not yet sent
  // Actually, empty string still creates the placeholder. Let's use a non-empty chunk then clear buffer manually.
  // Instead, drive this through a tool_call event:
  await adapter.stop();
});
```

Wait — testing the "placeholder but no reasoning content" case requires driving the tool call path. Replace that last test with a proper integration test using `handleTurnLifecycleEvent`:

```typescript
test("matrix adapter: thinking placeholder deleted when response arrives with empty reasoning buffer", async () => {
  const { createMatrixAdapter } = await import("../../channels/matrix/adapter");
  const adapter = createMatrixAdapter(TEST_ACCOUNT);
  await adapter.start();
  const client = getFakeClient();
  client.sendMessage
    .mockResolvedValueOnce("$thinking-placeholder") // from tool call path
    .mockResolvedValueOnce("$tool-block-1")
    .mockResolvedValueOnce("$plain-response");       // plain response (no drawer)

  const source = {
    channel: "matrix" as const,
    accountId: "acc1",
    chatId: "!room1:example.com",
    agentId: "agent1",
    conversationId: "conv1",
  };

  // Tool call arrives — sends thinking placeholder then tool block
  await adapter.handleTurnLifecycleEvent!({
    type: "tool_call",
    batchId: "b1",
    toolName: "bash",
    sources: [source],
  });
  await new Promise((r) => setTimeout(r, 10));

  // Response arrives with no reasoning content
  const result = await adapter.sendMessage({
    channel: "matrix",
    accountId: "acc1",
    chatId: "!room1:example.com",
    text: "Done.",
  });

  // Thinking placeholder must be redacted
  expect(client.redactEvent).toHaveBeenCalledWith("!room1:example.com", "$thinking-placeholder");

  // Response is plain (no thinking drawer)
  const [, responseContent] = client.sendMessage.mock.calls[2] as [string, Record<string, unknown>];
  expect((responseContent as Record<string, unknown>).formatted_body).toBeUndefined();
  expect((responseContent as Record<string, unknown>).body).toBe("Done.");
  expect(result.messageId).toBe("$plain-response");

  await adapter.stop();
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/tests/channels/matrix-adapter.test.ts 2>&1 | grep -E "reasoning|thinking placeholder|FAIL"
```

Expected: the rewritten reasoning test and the new placeholder test fail.

- [ ] **Step 3: Rewrite the reasoning path in `sendMessage` in `src/channels/matrix/adapter.ts`**

Replace the block from `// Reasoning display — combine drawer + answer into one edited message` through the closing `}` (lines 598–638) with:

```typescript
      // Reasoning display — delete thinking placeholder, send response with drawer on top
      const pendingReasoningMsgId = reasoningMessageIdByChatId.get(msg.chatId);
      if (pendingReasoningMsgId) {
        // If the placeholder send is still in-flight, wait for it to resolve (up to 2s)
        if (pendingReasoningMsgId === "__pending__") {
          const deadline = Date.now() + 2000;
          while (
            reasoningMessageIdByChatId.get(msg.chatId) === "__pending__" &&
            Date.now() < deadline
          ) {
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
        }

        stopReasoningFlush(msg.chatId);
        void stopTypingInterval(msg.chatId);

        const buffer = reasoningBufferByChatId.get(msg.chatId) ?? "";
        const resolvedMsgId = reasoningMessageIdByChatId.get(msg.chatId);
        clearReasoningState(msg.chatId);

        // Redact the thinking placeholder
        if (resolvedMsgId && resolvedMsgId !== "__pending__") {
          await client.redactEvent(msg.chatId, resolvedMsgId).catch((error) => {
            console.warn(
              "[Matrix] Failed to redact thinking placeholder:",
              error instanceof Error ? error.message : error,
            );
          });
        }

        // Send response with thinking drawer on top if reasoning content exists
        if (buffer) {
          const answerHtml =
            msg.parseMode === "HTML"
              ? markdownToMatrixHtml(msg.text ?? "")
              : escapeHtml(msg.text ?? "");
          const html = `<details><summary>Thinking</summary>\n${escapeHtml(buffer)}</details><hr>${answerHtml}`;
          const plainFallback = `Thinking\n---\n${msg.text ?? ""}`;
          const responseContent: Record<string, unknown> = {
            msgtype: "m.text",
            body: plainFallback,
            format: "org.matrix.custom.html",
            formatted_body: html,
          };
          if (msg.replyToMessageId) {
            responseContent["m.relates_to"] = {
              "m.in_reply_to": { event_id: msg.replyToMessageId },
            };
          }
          const eventId = await client.sendMessage(msg.chatId, responseContent);
          return { messageId: String(eventId) };
        }
        // No reasoning content — fall through to plain send below
      }
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/tests/channels/matrix-adapter.test.ts 2>&1 | grep -E "reasoning|thinking|FAIL|PASS" | head -20
```

Expected: all reasoning tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/matrix/adapter.ts src/tests/channels/matrix-adapter.test.ts
git commit -m "feat(matrix): redact thinking placeholder and send response as new message with drawer on top"
```

---

### Task 4: Redact thinking placeholder on turns ending without a response

**Files:**
- Modify: `src/channels/matrix/adapter.ts:759-768` (`handleTurnEvent "finished"` block)
- Modify: `src/tests/channels/matrix-adapter.test.ts` (add one new test)

- [ ] **Step 1: Write the failing test**

Add after the last reasoning test in `src/tests/channels/matrix-adapter.test.ts`:

```typescript
test("matrix adapter: thinking placeholder redacted when turn ends without response", async () => {
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

  // Reasoning arrives — thinking message sent
  await adapter.handleStreamReasoning!("Reasoning about this...", [source]);
  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  // Turn ends WITHOUT adapter.sendMessage being called
  await adapter.handleTurnLifecycleEvent!({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "completed",
  });

  // Thinking message must be redacted
  expect(client.redactEvent).toHaveBeenCalledWith("!room1:example.com", "$thinking-1");
  // No response message sent
  expect(client.sendMessage).toHaveBeenCalledTimes(1);

  await adapter.stop();
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test src/tests/channels/matrix-adapter.test.ts --test "thinking placeholder redacted when turn ends"
```

Expected: FAIL — `redactEvent` not called.

- [ ] **Step 3: Add redaction to the `"finished"` handler in `src/channels/matrix/adapter.ts`**

Find the `// "finished"` comment block (around line 759). Replace the body of the `for (const source of event.sources)` loop:

```typescript
      // "finished"
      for (const source of event.sources) {
        await stopTypingInterval(source.chatId);

        const pending = toolBlockOperationByChatId.get(source.chatId);
        if (pending) await pending.catch(() => {});
        toolBlockStateByChatId.delete(source.chatId);
        toolBlockOperationByChatId.delete(source.chatId);

        // Redact thinking placeholder if the turn ended without a response
        const reasoningMsgId = reasoningMessageIdByChatId.get(source.chatId);
        if (reasoningMsgId && reasoningMsgId !== "__pending__" && matrixClient) {
          await matrixClient.redactEvent(source.chatId, reasoningMsgId).catch((error) => {
            console.warn(
              "[Matrix] Failed to redact thinking placeholder on turn end:",
              error instanceof Error ? error.message : error,
            );
          });
        }

        clearReasoningState(source.chatId);
      }
```

- [ ] **Step 4: Run all adapter tests**

```bash
bun test src/tests/channels/matrix-adapter.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/matrix/adapter.ts src/tests/channels/matrix-adapter.test.ts
git commit -m "feat(matrix): redact thinking placeholder when turn ends without a response"
```

---

### Task 5: Reduce reasoning flush interval from 500ms to 150ms

**Files:**
- Modify: `src/channels/matrix/adapter.ts:208`

- [ ] **Step 1: Change the interval**

On line 208, change:
```typescript
    }, 500);
```
to:
```typescript
    }, 150);
```

- [ ] **Step 2: Run all tests**

```bash
bun test src/tests/channels/matrix-adapter.test.ts src/tests/channels/tool-block.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/channels/matrix/adapter.ts
git commit -m "perf(matrix): reduce reasoning flush interval from 500ms to 150ms"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Thinking before tools: Task 2 (`scheduleToolBlockUpdate` sends placeholder first)
- ✅ Delete thinking + fold into response: Task 3 (`sendMessage` redacts then sends new message)
- ✅ Delete thinking on no-response turn: Task 4 (`"finished"` handler redacts)
- ✅ No drawer when no reasoning content: Task 3 (empty buffer falls through to plain send)
- ✅ `showReasoning: false` skips placeholder: Task 2 (guards with `account.showReasoning !== false`)
- ✅ Tool block formatting: Task 1 (`renderToolBlock` updated)
- ✅ Flush interval reduced: Task 5

**Placeholder scan:** None found.

**Type consistency:** `reasoningMessageIdByChatId`, `reasoningBufferByChatId`, `clearReasoningState`, `stopReasoningFlush`, `startReasoningFlush`, `redactEvent` — all used consistently across tasks. `resolvedMsgId` is a new local in Task 3, used only within its block.
