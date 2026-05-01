// src/channels/matrix/matrixSender.ts
//
// Single source of truth for the Matrix wire-format shapes the adapter sends.
// Every m.replace, m.reaction, and plain message goes through here so the
// edit-fallback "* " prefix lands on plaintext body only — never on
// formatted_body. Element strips the leading "*" from formatted_body for
// edits, leaving a stray space that surfaces as a leading-space artifact.

export interface MatrixClientLike {
  sendMessage(roomId: string, content: unknown): Promise<string>;
  sendEvent(roomId: string, type: string, content: unknown): Promise<string>;
  redactEvent(roomId: string, eventId: string): Promise<string>;
}

export interface SendContent {
  text: string;
  html?: string;
  replyToMessageId?: string;
}

export interface EditContent {
  text: string;
  html?: string;
}

export class MatrixSender {
  constructor(private client: MatrixClientLike) {}

  async sendNew(roomId: string, content: SendContent): Promise<string> {
    const payload: Record<string, unknown> = {
      msgtype: "m.text",
      body: content.text,
    };
    if (content.html !== undefined) {
      payload.format = "org.matrix.custom.html";
      payload.formatted_body = content.html;
    }
    if (content.replyToMessageId) {
      payload["m.relates_to"] = {
        "m.in_reply_to": { event_id: content.replyToMessageId },
      };
    }
    const eventId = await this.client.sendMessage(roomId, payload);
    return String(eventId);
  }

  async edit(
    roomId: string,
    targetEventId: string,
    content: EditContent,
  ): Promise<string> {
    const newContent: Record<string, unknown> = {
      msgtype: "m.text",
      body: content.text,
    };
    const outer: Record<string, unknown> = {
      msgtype: "m.text",
      body: `* ${content.text}`,
    };
    if (content.html !== undefined) {
      newContent.format = "org.matrix.custom.html";
      newContent.formatted_body = content.html;
      // NOTE: outer formatted_body intentionally OMITS the "* " prefix.
      // Element strips the leading asterisk from formatted_body for edits,
      // producing a leading-space artifact. Plain `body` still gets "* "
      // because that fallback is for clients that don't honor m.new_content.
      outer.format = "org.matrix.custom.html";
      outer.formatted_body = content.html;
    }
    outer["m.new_content"] = newContent;
    outer["m.relates_to"] = { rel_type: "m.replace", event_id: targetEventId };
    const eventId = await this.client.sendEvent(roomId, "m.room.message", outer);
    return String(eventId);
  }

  async sendReaction(
    roomId: string,
    targetEventId: string,
    emoji: string,
  ): Promise<string> {
    const eventId = await this.client.sendEvent(roomId, "m.reaction", {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: targetEventId,
        key: emoji,
      },
    });
    return String(eventId);
  }

  async redact(roomId: string, eventId: string): Promise<string> {
    const redactionId = await this.client.redactEvent(roomId, eventId);
    return String(redactionId);
  }
}
