// src/channels/matrix/turn/StreamingMessage.ts
//
// Represents one stream segment in the turn timeline. Per turn, the assistant
// produces a sequence of messages: stream segment 1 → tool → stream segment 2
// → final. StreamingMessage owns the throttle/backoff/leading-edge edit logic
// for a single segment. Task 9 wires in the streaming-safe markdown formatter.
import type { MatrixSender } from "../matrixSender";
import type { MatrixBlock } from "./ThinkingBlock";

const STREAM_INTERVAL_MS = 250;
const STREAM_MAX_INTERVAL_MS = 8_000;

export type StreamingFormatter = (text: string) => {
  text: string;
  html: string;
};

export class StreamingMessage implements MatrixBlock {
  readonly posted: Promise<string>;
  private postedResolve: ((id: string) => void) | null = null;
  private postedReject: ((err: unknown) => void) | null = null;
  private eventId: string | null = null;
  private latestText = "";
  private lastFlushedText = "";
  private lastEditAt = 0;
  private currentInterval = STREAM_INTERVAL_MS;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private initialSendInflight = false;
  private initialSendStarted = false;

  constructor(
    private chatId: string,
    private sender: MatrixSender,
    private formatter: StreamingFormatter,
  ) {
    this.posted = new Promise<string>((resolve, reject) => {
      this.postedResolve = resolve;
      this.postedReject = reject;
    });
  }

  /** Snapshot of the latest accumulated text — used by ChatTurn.onStreamReset
   *  to finalize the segment with fully-rendered HTML. */
  get latestTextSnapshot(): string {
    return this.latestText;
  }

  onChunk(accumulatedText: string): void {
    if (this.disposed) return;
    this.latestText = accumulatedText;
    if (!this.initialSendStarted) {
      this.initialSendStarted = true;
      this.initialSendInflight = true;
      void this.initialSend();
      return;
    }
    if (this.initialSendInflight) return; // wait for initial post; on resolve we fire leading-edge.
    this.maybeFlush();
  }

  async replaceWithFinal(content: {
    text: string;
    html: string;
  }): Promise<string> {
    this.disposed = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    const eventId = await this.posted;
    await this.sender.edit(this.chatId, eventId, content).catch(() => {});
    return eventId;
  }

  // MatrixBlock.finalize: just delegates to replaceWithFinal with empty content.
  // For StreamingMessage, callers should use replaceWithFinal directly.
  async finalize(footer?: { text: string; html: string }): Promise<void> {
    if (footer) {
      await this.replaceWithFinal(footer);
    } else {
      this.dispose();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private async initialSend(): Promise<void> {
    const initialText = this.latestText;
    const { text, html } = this.formatter(initialText);
    try {
      const id = await this.sender.sendNew(this.chatId, { text, html });
      this.eventId = id;
      this.lastFlushedText = initialText;
      this.lastEditAt = Date.now();
      this.postedResolve?.(id);
    } catch (err) {
      this.postedReject?.(err);
      return;
    } finally {
      this.initialSendInflight = false;
    }
    // Leading-edge edit: if more text arrived while the initial send was in flight.
    if (!this.disposed && this.latestText !== this.lastFlushedText) {
      void this.flushNow();
    }
  }

  private maybeFlush(): void {
    const elapsed = Date.now() - this.lastEditAt;
    if (elapsed >= this.currentInterval) {
      void this.flushNow();
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        void this.flushNow();
      }, this.currentInterval - elapsed);
    }
  }

  async flushNow(): Promise<void> {
    if (this.disposed || this.eventId === null) return;
    const text = this.latestText;
    if (text === this.lastFlushedText) return;
    const { text: rendered, html } = this.formatter(text);
    try {
      await this.sender.edit(this.chatId, this.eventId, {
        text: rendered,
        html,
      });
      this.lastFlushedText = text;
      this.lastEditAt = Date.now();
    } catch (err) {
      const code = (err as { errcode?: string }).errcode;
      if (code === "M_LIMIT_EXCEEDED") {
        this.currentInterval = Math.min(
          this.currentInterval * 2,
          STREAM_MAX_INTERVAL_MS,
        );
        if (this.pendingTimer) clearTimeout(this.pendingTimer);
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null;
          void this.flushNow();
        }, this.currentInterval);
      }
      // other errors: silently drop
    }
  }
}
