// src/channels/matrix/turn/ToolBlock.ts
//
// Renders the "🔧 Tools used:" block.  Entries are created via two paths:
//
//  • onToolScheduled(toolName, description?)
//      Called from ChatTurn.onToolCallScheduled when a tool_call event arrives.
//      Adds a basic entry using the grouped label format from the old adapter
//      (deduplicating by name+description with a "(xN)" count).  Posts/edits
//      the block immediately so the listing appears before tool execution.
//
//  • onToolStart(call)  /  onToolEnd(toolCallId, outcome)
//      Called from ChatTurn.onToolStart/onToolEnd when tool_started/tool_ended
//      events arrive.  These attach per-tool timing to entries.  If onToolStart
//      fires without a prior onToolScheduled entry (e.g. a tool_started arrives
//      without a preceding tool_call), a new entry is created here.  This is the
//      path that fixes issue #6 — per-tool durations persist in the block.
//
//  • finalize()
//      Emits one final edit with all durations settled, then stops all timers.

import { buildArgsPreview, escapeHtml, formatElapsed } from "../htmlFormat";
import type { MatrixSender } from "../matrixSender";
import type { MatrixBlock } from "./ThinkingBlock";

// Tools that are the adapter's own outbound-channel surface — never shown.
const HIDDEN_TOOLS = new Set(["ChannelAction", "NotifyUser"]);

// After an entry has been running for this long we start the live ticker.
const LIVE_GRACE_MS = 1_000;

// Ticker cadence while at least one entry is running past the grace window.
const LIVE_TICK_MS = 5_000;

export interface ToolStartCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

interface ScheduledEntry {
  kind: "scheduled";
  /** Dedup key: toolName + description */
  key: string;
  /** Human-readable label shown in the block. */
  label: string;
  /** How many times this name+desc pair has been scheduled. */
  count: number;
}

interface TimedEntry {
  kind: "timed";
  toolCallId: string;
  toolName: string;
  argsPreview: string;
  startedAt: number;
  endedAt?: number;
  outcome?: "success" | "error";
  /** Timer that fires once LIVE_GRACE_MS after start if still running. */
  graceTimer: ReturnType<typeof setTimeout> | null;
}

type ToolEntry = ScheduledEntry | TimedEntry;

function makeScheduledKey(toolName: string, description?: string): string {
  return description ? `${toolName}\0${description}` : toolName;
}

function makeScheduledLabel(toolName: string, description?: string): string {
  return description ? `${toolName} — ${description}` : toolName;
}

export class ToolBlock implements MatrixBlock {
  readonly posted: Promise<string>;

  private eventId: string | null = null;
  private entries: ToolEntry[] = [];
  private op: Promise<void> = Promise.resolve();
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private finalized = false;

  // Resolved once the block has been posted.
  private resolvePosted!: (id: string) => void;
  private rejectPosted!: (err: unknown) => void;

  constructor(
    private readonly chatId: string,
    private readonly sender: MatrixSender,
  ) {
    this.posted = new Promise<string>((res, rej) => {
      this.resolvePosted = res;
      this.rejectPosted = rej;
    });
  }

  // ── Public lifecycle signals ────────────────────────────────────────────────

  /**
   * Called when a tool_call event arrives (tool scheduled by the LLM).
   * Adds/increments a grouped entry and posts/edits the block immediately.
   */
  onToolScheduled(toolName: string, description?: string): void {
    if (this.finalized) return;
    if (HIDDEN_TOOLS.has(toolName)) return;

    const key = makeScheduledKey(toolName, description);
    const existing = this.entries.find(
      (e): e is ScheduledEntry => e.kind === "scheduled" && e.key === key,
    );
    if (existing) {
      existing.count += 1;
    } else {
      this.entries.push({
        kind: "scheduled",
        key,
        label: makeScheduledLabel(toolName, description),
        count: 1,
      });
    }
    this.scheduleEdit();
  }

  /**
   * Called when a tool_started event arrives (execution began).
   * Attaches per-tool timing to the entry or creates one if not already present.
   */
  onToolStart(call: ToolStartCall): void {
    if (this.finalized) return;
    if (HIDDEN_TOOLS.has(call.toolName)) return;

    // Check if there's already a timed entry for this call (shouldn't happen).
    if (
      this.entries.some(
        (e) => e.kind === "timed" && e.toolCallId === call.toolCallId,
      )
    ) {
      return;
    }

    const entry: TimedEntry = {
      kind: "timed",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      argsPreview: buildArgsPreview(call.toolName, call.args),
      startedAt: Date.now(),
      graceTimer: null,
    };

    // If there's a matching scheduled entry (same toolName), replace it with
    // this timed entry so we don't double-list. We replace the first matching
    // scheduled entry that hasn't yet been consumed by a timed entry.
    const scheduledIdx = this.entries.findIndex(
      (e): e is ScheduledEntry =>
        e.kind === "scheduled" && e.key.startsWith(call.toolName),
    );
    if (scheduledIdx !== -1) {
      const scheduled = this.entries[scheduledIdx] as ScheduledEntry;
      if (scheduled.count <= 1) {
        // Replace the scheduled entry with the timed entry.
        this.entries.splice(scheduledIdx, 1, entry);
      } else {
        // Decrement count and add timed entry at the same position.
        scheduled.count -= 1;
        this.entries.splice(scheduledIdx, 0, entry);
      }
    } else {
      // No scheduled entry — this tool_started arrived without a prior tool_call.
      this.entries.push(entry);
    }

    this.scheduleEdit();

    // After the grace window, start the live ticker so running durations update.
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = null;
      this.startLiveTicker();
    }, LIVE_GRACE_MS);
  }

  onToolEnd(toolCallId: string, outcome: "success" | "error"): void {
    if (this.finalized) return;

    const entry = this.entries.find(
      (e): e is TimedEntry => e.kind === "timed" && e.toolCallId === toolCallId,
    );
    if (!entry) return;

    // Cancel the grace timer if the tool ended before 1s.
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
    entry.endedAt = Date.now();
    entry.outcome = outcome;

    // Stop live ticker if no more running entries.
    this.maybeStopLiveTicker();

    // Emit a final edit for this completion.
    this.scheduleEdit();
  }

  /** Drain any pending serialized edits — used by sendOutbound to ensure the
   *  tool block has settled before posting the outbound message. */
  async drainPending(): Promise<void> {
    await this.op.catch(() => {});
  }

  async finalize(): Promise<void> {
    this.finalized = true;
    // Cancel all pending grace timers.
    for (const e of this.entries) {
      if (e.kind === "timed" && e.graceTimer) {
        clearTimeout(e.graceTimer);
        e.graceTimer = null;
      }
    }
    this.stopLiveTicker();

    // Flush any pending edit and emit one final render.
    await this.op.catch(() => {});
    if (this.eventId === null) return; // nothing was ever posted
    await this.sender
      .edit(this.chatId, this.eventId, this.render())
      .catch(() => {});
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Chain a coalesced edit on the serialized op chain. */
  private scheduleEdit(): void {
    this.op = this.op
      .catch(() => {})
      .then(async () => {
        if (this.entries.length === 0) return;
        if (this.eventId === null) {
          // First post.
          try {
            const id = await this.sender.sendNew(this.chatId, this.render());
            this.eventId = id;
            this.resolvePosted(id);
          } catch (err) {
            this.rejectPosted(err);
          }
        } else {
          await this.sender
            .edit(this.chatId, this.eventId, this.render())
            .catch(() => {});
        }
      })
      .catch(() => {});
  }

  private startLiveTicker(): void {
    if (this.liveTimer || this.finalized) return;
    this.liveTimer = setInterval(() => {
      if (this.finalized) {
        this.stopLiveTicker();
        return;
      }
      this.scheduleEdit();
    }, LIVE_TICK_MS);
  }

  private stopLiveTicker(): void {
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
  }

  private maybeStopLiveTicker(): void {
    const hasRunning = this.entries.some(
      (e) => e.kind === "timed" && e.endedAt === undefined,
    );
    if (!hasRunning) this.stopLiveTicker();
  }

  /** Build the plain-text and HTML representations. */
  private render(): { text: string; html: string } {
    const now = Date.now();
    const lines: string[] = [];
    const htmlLines: string[] = [];

    for (const entry of this.entries) {
      if (entry.kind === "scheduled") {
        // Basic grouped entry — no timing info.
        const label =
          entry.count === 1 ? entry.label : `${entry.label} (x${entry.count})`;
        lines.push(label);
        htmlLines.push(escapeHtml(label));
      } else {
        // Timed entry with per-tool duration.
        const durationMs = (entry.endedAt ?? now) - entry.startedAt;
        const elapsed = Math.floor(durationMs / 1000);
        const showDuration = elapsed >= 1;

        const label = entry.argsPreview
          ? `${entry.toolName} — ${entry.argsPreview}`
          : entry.toolName;
        const htmlLabel = entry.argsPreview
          ? `${escapeHtml(entry.toolName)} — <code>${escapeHtml(entry.argsPreview)}</code>`
          : escapeHtml(entry.toolName);

        if (entry.endedAt !== undefined) {
          // Completed entry.
          if (entry.outcome === "error") {
            if (showDuration) {
              lines.push(
                `${label} (errored after ${formatElapsed(durationMs)})`,
              );
              htmlLines.push(
                `${htmlLabel} <span data-mx-color="#f85149">(errored after ${formatElapsed(durationMs)})</span>`,
              );
            } else {
              lines.push(`${label} (errored)`);
              htmlLines.push(
                `${htmlLabel} <span data-mx-color="#f85149">(errored)</span>`,
              );
            }
          } else {
            // success
            if (showDuration) {
              lines.push(`${label} (${formatElapsed(durationMs)})`);
              htmlLines.push(
                `${htmlLabel} <span data-mx-color="#8b949e">(${formatElapsed(durationMs)})</span>`,
              );
            } else {
              // Sub-1s success — no parenthesized duration.
              lines.push(label);
              htmlLines.push(htmlLabel);
            }
          }
        } else {
          // Still running.
          if (showDuration) {
            lines.push(`${label} (running ${formatElapsed(durationMs)})`);
            htmlLines.push(
              `${htmlLabel} <span data-mx-color="#e3b341">(running ${formatElapsed(durationMs)}…)</span>`,
            );
          } else {
            lines.push(label);
            htmlLines.push(htmlLabel);
          }
        }
      }
    }

    const text = `🔧 Tools used:\n${lines.join("\n")}`;
    const html = `🔧 <b>Tools used:</b><br>${htmlLines.join("<br>")}`;
    return { text, html };
  }
}
