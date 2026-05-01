import { expect, mock, test } from "bun:test";
import { MatrixSender } from "../../channels/matrix/matrixSender";
import { ThinkingBlock } from "../../channels/matrix/turn/ThinkingBlock";

function stubSender() {
  let counter = 0;
  const sender = new MatrixSender({
    sendMessage: mock(async () => `$evt:${++counter}`),
    sendEvent: mock(async () => `$evt:${++counter}`),
    redactEvent: mock(async () => `$red:${++counter}`),
  } as any);
  return sender;
}

test("posts 'Thinking...' on construction", async () => {
  const sender = stubSender();
  const sendNew = mock(sender.sendNew.bind(sender));
  (sender as any).sendNew = sendNew;
  const block = new ThinkingBlock("!room:t", sender);
  await block.posted;
  expect(sendNew).toHaveBeenCalledWith("!room:t", {
    text: "Thinking...",
    html: "<b>Thinking...</b>",
  });
});

test("appendChunk buffers content; flush interval edits placeholder", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;
  const block = new ThinkingBlock("!room:t", sender);
  await block.posted;
  block.appendChunk("Considering");
  block.appendChunk(" the options.");
  await new Promise((r) => setTimeout(r, 200)); // > 150ms cadence
  expect(edit).toHaveBeenCalled();
  const lastCall = edit.mock.calls[edit.mock.calls.length - 1]!;
  expect(lastCall[2].html).toContain("Considering the options.");
  await block.finalize();
});

test("dedupes identical content across flush intervals", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;
  const block = new ThinkingBlock("!room:t", sender);
  await block.posted;
  block.appendChunk("hello");
  await new Promise((r) => setTimeout(r, 200));
  const callsAfterFirst = edit.mock.calls.length;
  await new Promise((r) => setTimeout(r, 200)); // no new content; should not re-edit
  expect(edit.mock.calls.length).toBe(callsAfterFirst);
  await block.finalize();
});

test("markToolInterruption inserts separator before next chunk", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;
  const block = new ThinkingBlock("!room:t", sender);
  await block.posted;
  block.appendChunk("first");
  block.markToolInterruption();
  block.appendChunk("second");
  await new Promise((r) => setTimeout(r, 200));
  const lastCall = edit.mock.calls[edit.mock.calls.length - 1]!;
  expect(lastCall[2].html).toContain("<hr>"); // separator between segments
  await block.finalize();
});

test("finalize with no buffer and no footer is a no-op edit", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;
  const block = new ThinkingBlock("!room:t", sender);
  await block.posted;
  edit.mockClear();
  await block.finalize();
  expect(edit).not.toHaveBeenCalled();
});

test("finalize with footer appends it", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;
  const block = new ThinkingBlock("!room:t", sender);
  await block.posted;
  block.appendChunk("done thinking");
  await block.finalize({ text: "\n· Cancelled", html: "<i>Cancelled</i>" });
  const lastCall = edit.mock.calls[edit.mock.calls.length - 1]!;
  expect(lastCall[2].html).toContain("Cancelled");
  expect(lastCall[2].text).toContain("Cancelled");
});
