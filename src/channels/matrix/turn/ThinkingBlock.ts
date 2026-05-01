// src/channels/matrix/turn/ThinkingBlock.ts
//
// Reasoning text only. Lazy-constructed by ChatTurn on the first
// onReasoningChunk — turns with no reasoning never post a placeholder.

import { clipReasoningForMatrix, escapeHtml } from "../htmlFormat";
import type { MatrixSender } from "../matrixSender";

export interface MatrixBlock {
  readonly posted: Promise<string>;
  finalize(footer?: { text: string; html: string }): Promise<void>;
}

const FLUSH_INTERVAL_MS = 150;

export class ThinkingBlock implements MatrixBlock {
  readonly posted: Promise<string>;
  private eventId: string | null = null;
  private buffer = "";
  private needsSeparator = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private lastFlushed: string | null = null;
  private flushInProgress = false;
  private finalized = false;

  constructor(
    private chatId: string,
    private sender: MatrixSender,
  ) {
    this.posted = this.sender
      .sendNew(this.chatId, { text: "Thinking...", html: "<b>Thinking...</b>" })
      .then((id) => {
        this.eventId = id;
        this.startFlushInterval();
        return id;
      });
  }

  appendChunk(chunk: string): void {
    if (this.finalized) return;
    if (this.needsSeparator && this.buffer) {
      this.buffer += "\n--\n";
      this.needsSeparator = false;
    }
    const spacer =
      this.buffer.length > 0 && /[.!?]$/.test(this.buffer) && /^\S/.test(chunk)
        ? " "
        : "";
    this.buffer += spacer + chunk;
  }

  markToolInterruption(): void {
    this.needsSeparator = true;
  }

  async finalize(footer?: { text: string; html: string }): Promise<void> {
    this.finalized = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.buffer && !footer) return;
    const eventId = await this.posted;
    const buffer = clipReasoningForMatrix(this.buffer);
    const innerHtml =
      (buffer
        ? escapeHtml(buffer)
            .replace(/\n--\n/g, "<hr>")
            .replace(/\n/g, "<br>")
        : "") + (footer ? `<hr>${footer.html}` : "");
    const html = `<b>Thinking</b><br><blockquote>${innerHtml}</blockquote>`;
    const plainText = `Thinking\n${buffer}${footer ? `\n${footer.text}` : ""}`;
    await this.sender.edit(this.chatId, eventId, { text: plainText, html });
  }

  private startFlushInterval(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    if (this.flushInProgress || this.finalized || this.eventId === null) return;
    const html = this.buildPlaceholderHtml();
    if (html === null || html === this.lastFlushed) return;
    this.flushInProgress = true;
    try {
      await this.sender.edit(this.chatId, this.eventId, {
        text: "Thinking...",
        html,
      });
      this.lastFlushed = html;
    } finally {
      this.flushInProgress = false;
    }
  }

  private buildPlaceholderHtml(): string | null {
    const buffer = clipReasoningForMatrix(this.buffer);
    if (!buffer) return null;
    const inner = escapeHtml(buffer)
      .replace(/\n--\n/g, "<hr>")
      .replace(/\n/g, "<br>");
    return `<b>Thinking...</b><br><blockquote>${inner}</blockquote>`;
  }
}
