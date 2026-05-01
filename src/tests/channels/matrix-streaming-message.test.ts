import { expect, mock, test } from "bun:test";
import { MatrixSender } from "../../channels/matrix/matrixSender";
import { StreamingMessage } from "../../channels/matrix/turn/StreamingMessage";

function stubSender() {
  let counter = 0;
  return new MatrixSender({
    sendMessage: mock(async () => `$evt:${++counter}`),
    sendEvent: mock(async () => `$evt:${++counter}`),
    redactEvent: mock(async () => `$red:${++counter}`),
  } as any);
}

const passthroughFormatter = (text: string) => ({ text, html: text });

test("first onChunk posts initial message", async () => {
  const sender = stubSender();
  const sendNew = mock(sender.sendNew.bind(sender));
  (sender as any).sendNew = sendNew;
  const sm = new StreamingMessage("!r:t", sender, passthroughFormatter);
  sm.onChunk("hello");
  await sm.posted;
  expect(sendNew).toHaveBeenCalledWith("!r:t", {
    text: "hello",
    html: "hello",
  });
});

test("subsequent chunks edit, throttled to 250ms floor", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;
  const sm = new StreamingMessage("!r:t", sender, passthroughFormatter);
  sm.onChunk("hello");
  await sm.posted;
  sm.onChunk("hello world");
  // Within 250ms window, no edit yet.
  await new Promise((r) => setTimeout(r, 50));
  expect(edit).not.toHaveBeenCalled();
  // Past the window, edit fires.
  await new Promise((r) => setTimeout(r, 250));
  expect(edit).toHaveBeenCalled();
  sm.dispose();
});

test("replaceWithFinal sends m.replace and resolves", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;
  const sm = new StreamingMessage("!r:t", sender, passthroughFormatter);
  sm.onChunk("partial");
  await sm.posted;
  const id = await sm.replaceWithFinal({ text: "final", html: "<b>final</b>" });
  expect(id).toBe(await sm.posted);
  expect(edit).toHaveBeenCalledWith("!r:t", expect.any(String), {
    text: "final",
    html: "<b>final</b>",
  });
});

test("dispose cancels pending timer", async () => {
  const sender = stubSender();
  const edit = mock(sender.edit.bind(sender));
  (sender as any).edit = edit;
  const sm = new StreamingMessage("!r:t", sender, passthroughFormatter);
  sm.onChunk("hello");
  await sm.posted;
  sm.onChunk("hello world");
  sm.dispose();
  await new Promise((r) => setTimeout(r, 300));
  expect(edit).not.toHaveBeenCalled();
});

test("leading-edge edit when chunks arrive before initial post resolves", async () => {
  let resolveSend: ((id: string) => void) | null = null;
  const sendEvent = mock(async () => "$edit");
  const client = {
    sendMessage: mock(
      () =>
        new Promise<string>((r) => {
          resolveSend = r;
        }),
    ),
    sendEvent,
    redactEvent: mock(async () => "$red"),
  } as any;
  const sender = new MatrixSender(client);
  const sm = new StreamingMessage("!r:t", sender, passthroughFormatter);
  sm.onChunk("hello"); // triggers send (pending)
  sm.onChunk("hello, world"); // accumulates while pending
  resolveSend!("$initial");
  await sm.posted;
  await new Promise((r) => setTimeout(r, 10));
  // After resolution, an immediate edit should have fired with the latest text.
  expect(sendEvent.mock.calls.length).toBe(1);
});
