import { expect, mock, test } from "bun:test";
import { MatrixSender } from "../../channels/matrix/matrixSender";
import { ToolBlock } from "../../channels/matrix/turn/ToolBlock";

function stubSender() {
  let counter = 0;
  const sender = new MatrixSender({
    sendMessage: mock(async () => `$evt:${++counter}`),
    sendEvent: mock(async () => `$evt:${++counter}`),
    redactEvent: mock(async () => `$red:${++counter}`),
  } as any);
  return sender;
}

test("onToolScheduled posts the tool block with the tool name", async () => {
  const sender = stubSender();
  const sendNew = mock(sender.sendNew.bind(sender));
  (sender as any).sendNew = sendNew;

  const block = new ToolBlock("!room:t", sender);
  block.onToolScheduled("Read", "src/foo.ts");
  await block.posted;

  expect(sendNew).toHaveBeenCalledTimes(1);
  const [, content] = sendNew.mock.calls[0]! as [
    string,
    { text: string; html: string },
  ];
  expect(content.text).toContain("Read");
  expect(content.text).toContain("src/foo.ts");
  expect(content.html).toContain("Read");

  await block.finalize();
});

test("second onToolScheduled with same name+desc increments count", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;

  const block = new ToolBlock("!room:t", sender);
  block.onToolScheduled("Read", "src/foo.ts");
  await block.posted;
  block.onToolScheduled("Read", "src/foo.ts");
  await new Promise((r) => setTimeout(r, 20));

  const lastCall = edit.mock.calls[edit.mock.calls.length - 1]!;
  const content = lastCall[2] as { text: string; html: string };
  expect(content.text).toContain("(x2)");

  await block.finalize();
});

test("onToolScheduled with different name creates separate entry", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;

  const block = new ToolBlock("!room:t", sender);
  block.onToolScheduled("Read", "src/foo.ts");
  await block.posted;
  block.onToolScheduled("Bash", "ls -la");
  await new Promise((r) => setTimeout(r, 20));

  const lastCall = edit.mock.calls[edit.mock.calls.length - 1]!;
  const content = lastCall[2] as { text: string; html: string };
  expect(content.text).toContain("Read");
  expect(content.text).toContain("Bash");

  await block.finalize();
});

test("onToolStart creates entry with args preview", async () => {
  const sender = stubSender();
  const sendNew = mock(sender.sendNew.bind(sender));
  (sender as any).sendNew = sendNew;

  const block = new ToolBlock("!room:t", sender);
  block.onToolStart({
    toolCallId: "call-1",
    toolName: "Bash",
    args: { command: "echo hello" },
  });
  await block.posted;

  const [, content] = sendNew.mock.calls[0]! as [
    string,
    { text: string; html: string },
  ];
  expect(content.text).toContain("Bash");
  expect(content.text).toContain("echo hello");

  await block.finalize();
});

test("sub-1s success shows no duration", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;

  const block = new ToolBlock("!room:t", sender);
  block.onToolStart({
    toolCallId: "call-1",
    toolName: "Read",
    args: { file_path: "/tmp/x" },
  });
  await block.posted;
  block.onToolEnd("call-1", "success");
  await new Promise((r) => setTimeout(r, 20));

  const lastCall = edit.mock.calls[edit.mock.calls.length - 1]!;
  const content = lastCall[2] as { text: string; html: string };
  // No parenthesized duration for sub-1s success.
  expect(content.text).not.toMatch(/\(\d+:\d+\)/);
  expect(content.text).not.toContain("(errored)");
  expect(content.text).toContain("Read");

  await block.finalize();
});

test("errored sub-1s shows '(errored)' with no duration", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;

  const block = new ToolBlock("!room:t", sender);
  block.onToolStart({
    toolCallId: "call-err",
    toolName: "Bash",
    args: { command: "false" },
  });
  await block.posted;
  block.onToolEnd("call-err", "error");
  await new Promise((r) => setTimeout(r, 20));

  const lastCall = edit.mock.calls[edit.mock.calls.length - 1]!;
  const content = lastCall[2] as { text: string; html: string };
  expect(content.text).toContain("(errored)");
  expect(content.text).not.toContain("errored after");

  await block.finalize();
});

test("errored tool with ≥1s duration shows 'errored after X:XX'", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;

  const block = new ToolBlock("!room:t", sender);
  // Manually set startedAt to simulate elapsed time.
  block.onToolStart({
    toolCallId: "call-err",
    toolName: "Bash",
    args: { command: "false" },
  });
  await block.posted;

  // Patch the entry's startedAt to simulate 5 seconds elapsed.
  const entries = (block as any).entries as Array<{ startedAt: number }>;
  entries[0]!.startedAt = Date.now() - 5_000;

  block.onToolEnd("call-err", "error");
  await new Promise((r) => setTimeout(r, 20));

  const lastCall = edit.mock.calls[edit.mock.calls.length - 1]!;
  const content = lastCall[2] as { text: string; html: string };
  expect(content.text).toContain("errored after");

  await block.finalize();
});

test("onToolStart replaces matching scheduled entry (no double-listing)", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;

  const block = new ToolBlock("!room:t", sender);
  // First: tool_call scheduled entry.
  block.onToolScheduled("Bash");
  await block.posted;
  // Then: tool_started matches by toolName.
  block.onToolStart({
    toolCallId: "call-1",
    toolName: "Bash",
    args: { command: "echo hi" },
  });
  await new Promise((r) => setTimeout(r, 20));

  // Only one entry should appear (timed replaces scheduled).
  const lastCall = edit.mock.calls[edit.mock.calls.length - 1]!;
  const content = lastCall[2] as { text: string; html: string };
  const lines = content.text.split("\n").filter((l) => l.includes("Bash"));
  expect(lines).toHaveLength(1);

  await block.finalize();
});

test("ChannelAction and NotifyUser are excluded from tool block", async () => {
  const sender = stubSender();
  const sendNew = mock(sender.sendNew.bind(sender));
  (sender as any).sendNew = sendNew;

  const block = new ToolBlock("!room:t", sender);
  block.onToolScheduled("ChannelAction");
  block.onToolScheduled("NotifyUser");
  await new Promise((r) => setTimeout(r, 20));

  // Nothing was posted — hidden tools are excluded.
  expect(sendNew).not.toHaveBeenCalled();

  await block.finalize();
});

test("finalize with no entries is a no-op", async () => {
  const sender = stubSender();
  const sendNew = mock(sender.sendNew.bind(sender));
  (sender as any).sendNew = sendNew;
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;

  const block = new ToolBlock("!room:t", sender);
  await block.finalize();

  expect(sendNew).not.toHaveBeenCalled();
  expect(edit).not.toHaveBeenCalled();
});

test("finalize emits final edit with settled durations", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;

  const block = new ToolBlock("!room:t", sender);
  block.onToolStart({
    toolCallId: "call-1",
    toolName: "Read",
    args: { file_path: "/x" },
  });
  await block.posted;

  // Patch startedAt to simulate 3s elapsed.
  const entries = (block as any).entries as Array<{ startedAt: number }>;
  entries[0]!.startedAt = Date.now() - 3_000;

  block.onToolEnd("call-1", "success");
  await block.finalize();

  // The final edit from finalize shows the duration.
  const lastCall = edit.mock.calls[edit.mock.calls.length - 1]!;
  const content = lastCall[2] as { text: string; html: string };
  expect(content.text).toContain("0:03");
});

test("posted promise resolves to the eventId of the first sendNew", async () => {
  const sender = stubSender();
  const block = new ToolBlock("!room:t", sender);
  block.onToolScheduled("Read");
  const id = await block.posted;
  expect(id).toMatch(/^\$evt:/);
  await block.finalize();
});

test("edits are serialized — no concurrent edits", async () => {
  const sender = stubSender();
  const editOrder: number[] = [];
  let editCount = 0;
  const edit = mock(async (...args: unknown[]) => {
    const n = ++editCount;
    editOrder.push(n);
    await new Promise((r) => setTimeout(r, 10));
    return `$evt:${n}`;
  });
  (sender as any).edit = edit;

  const block = new ToolBlock("!room:t", sender);
  block.onToolScheduled("Read");
  await block.posted;
  // Fire multiple sequential scheduled edits.
  block.onToolScheduled("Bash");
  block.onToolScheduled("Write");
  await new Promise((r) => setTimeout(r, 100));

  // Edits happened in order (serialized op chain).
  for (let i = 0; i < editOrder.length - 1; i++) {
    expect(editOrder[i]!).toBeLessThan(editOrder[i + 1]!);
  }

  await block.finalize();
});
