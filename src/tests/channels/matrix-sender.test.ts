import { test, expect, mock } from "bun:test";
import { MatrixSender } from "../../channels/matrix/matrixSender";

function stubClient() {
  return {
    sendMessage: mock(async () => "$evt:test"),
    sendEvent: mock(async () => "$evt:test"),
    redactEvent: mock(async () => "$red:test"),
  } as any;
}

test("sendNew with text only sends m.text without formatted_body", async () => {
  const c = stubClient();
  const s = new MatrixSender(c);
  await s.sendNew("!room:t", { text: "hello" });
  expect(c.sendMessage).toHaveBeenCalledWith("!room:t", {
    msgtype: "m.text",
    body: "hello",
  });
});

test("sendNew with text + html includes formatted_body", async () => {
  const c = stubClient();
  const s = new MatrixSender(c);
  await s.sendNew("!room:t", { text: "hi", html: "<b>hi</b>" });
  expect(c.sendMessage).toHaveBeenCalledWith("!room:t", {
    msgtype: "m.text",
    body: "hi",
    format: "org.matrix.custom.html",
    formatted_body: "<b>hi</b>",
  });
});

test("sendNew with replyToMessageId attaches m.in_reply_to", async () => {
  const c = stubClient();
  const s = new MatrixSender(c);
  await s.sendNew("!r:t", { text: "ack", replyToMessageId: "$orig" });
  const call = c.sendMessage.mock.calls[0][1];
  expect(call["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$orig" } });
});

test("edit applies '* ' prefix only to plaintext body, never to formatted_body", async () => {
  const c = stubClient();
  const s = new MatrixSender(c);
  const returned = await s.edit("!r:t", "$orig", { text: "new", html: "<b>new</b>" });
  expect(returned).toBe("$evt:test");
  const call = c.sendEvent.mock.calls[0];
  expect(call[1]).toBe("m.room.message");
  const content = call[2];
  expect(content.body).toBe("* new");
  expect(content.formatted_body).toBe("<b>new</b>");        // NO leading "* "
  expect(content["m.new_content"]).toEqual({
    msgtype: "m.text",
    body: "new",
    format: "org.matrix.custom.html",
    formatted_body: "<b>new</b>",
  });
  expect(content["m.relates_to"]).toEqual({
    rel_type: "m.replace",
    event_id: "$orig",
  });
});

test("edit with text only omits format/formatted_body in both envelopes", async () => {
  const c = stubClient();
  const s = new MatrixSender(c);
  await s.edit("!r:t", "$orig", { text: "new" });
  const content = c.sendEvent.mock.calls[0][2];
  expect(content.body).toBe("* new");
  expect(content).not.toHaveProperty("formatted_body");
  expect(content["m.new_content"]).toEqual({ msgtype: "m.text", body: "new" });
});

test("sendReaction posts m.reaction with annotation relation", async () => {
  const c = stubClient();
  const s = new MatrixSender(c);
  await s.sendReaction("!r:t", "$tgt", "👍");
  expect(c.sendEvent).toHaveBeenCalledWith("!r:t", "m.reaction", {
    "m.relates_to": { rel_type: "m.annotation", event_id: "$tgt", key: "👍" },
  });
});

test("redact calls client.redactEvent and returns the redaction event ID", async () => {
  const c = stubClient();
  const s = new MatrixSender(c);
  const returned = await s.redact("!r:t", "$tgt");
  expect(c.redactEvent).toHaveBeenCalledWith("!r:t", "$tgt");
  expect(returned).toBe("$red:test");
});
