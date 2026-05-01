import { expect, mock, test } from "bun:test";
import { MatrixSender } from "../../channels/matrix/matrixSender";
import { ChatTurn } from "../../channels/matrix/turn/ChatTurn";

function fixture() {
  let counter = 0;
  const calls: { method: string; args: unknown[] }[] = [];
  const stubClient = {
    sendMessage: mock(async (...args: unknown[]) => {
      calls.push({ method: "sendMessage", args });
      return `$evt:${++counter}`;
    }),
    sendEvent: mock(async (...args: unknown[]) => {
      calls.push({ method: "sendEvent", args });
      return `$evt:${++counter}`;
    }),
    redactEvent: mock(async () => `$red:${++counter}`),
    setTyping: mock(async () => {}),
  } as any;
  const sender = new MatrixSender(stubClient);
  const account = { showReasoning: true, showContextUsage: true } as any;
  const turn = new ChatTurn({
    chatId: "!room:t",
    sender,
    client: stubClient,
    account,
    onDispose: () => {},
    setLastSentMessageId: () => {},
  });
  return { turn, stubClient, calls };
}

test("turn with no reasoning never posts a thinking placeholder", async () => {
  const { turn, calls } = fixture();
  turn.onProcessing();
  // Simulate a tool-only turn followed by a final response.
  turn.onToolCallScheduled("Read", "src/foo.ts");
  await new Promise((r) => setTimeout(r, 10));
  await turn.finish({
    type: "finished",
    batchId: "b1",
    outcome: "completed",
    sources: [
      {
        channel: "matrix" as const,
        accountId: "acc1",
        chatId: "!room:t",
        agentId: "agent1",
        conversationId: "c1",
      },
    ],
    usage: { contextTokens: 0, contextWindowMax: 0 },
  });
  // No "Thinking..." sent
  const thinkingSends = calls.filter(
    (c) =>
      c.method === "sendMessage" && (c.args[1] as any).body === "Thinking...",
  );
  expect(thinkingSends.length).toBe(0);
});

test("turn with reasoning posts and finalizes the thinking block", async () => {
  const { turn, calls } = fixture();
  turn.onProcessing();
  await turn.onReasoningChunk("considering");
  await new Promise((r) => setTimeout(r, 200));
  await turn.finish({
    type: "finished",
    batchId: "b1",
    outcome: "completed",
    sources: [
      {
        channel: "matrix" as const,
        accountId: "acc1",
        chatId: "!room:t",
        agentId: "agent1",
        conversationId: "c1",
      },
    ],
    usage: { contextTokens: 0, contextWindowMax: 0 },
  });
  // "Thinking..." was posted
  const thinkingSends = calls.filter(
    (c) =>
      c.method === "sendMessage" && (c.args[1] as any).body === "Thinking...",
  );
  expect(thinkingSends.length).toBeGreaterThan(0);
});
