// src/channels/matrix/htmlFormat.ts
//
// Pure formatting helpers shared across the Matrix adapter modules. No
// dependence on the adapter's mutable state; safe to import from any
// module that needs to produce or transform Matrix message bodies.
import { marked } from "marked";

// Inlined here rather than imported from channels/format.ts to avoid the transitive import
// chain (registry → accounts → config) that conflicts with mock.module() in tests.
/**
 * Convert HTML <table> to a column-aligned ASCII table in a <pre> block.
 * Strips <table>, <thead>, <tbody>, <tr>, <th>, <td> tags, then aligns columns.
 * Returns null if no table found in the HTML.
 */
export function htmlTableToAscii(html: string): string | null {
  // Quick check: no table, bail early
  if (!html.includes("<table")) return null;

  // Extract all rows as arrays of cell texts
  const rows: string[][] = [];
  const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
  const cellRegex = /<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;

  for (
    let rowMatch = rowRegex.exec(html);
    rowMatch !== null;
    rowMatch = rowRegex.exec(html)
  ) {
    const rowHtml = rowMatch[1] ?? "";
    const cells: string[] = [];
    for (
      let cellMatch = cellRegex.exec(rowHtml);
      cellMatch !== null;
      cellMatch = cellRegex.exec(rowHtml)
    ) {
      // Strip HTML tags from cell content, collapse whitespace
      const cell = (cellMatch[1] ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#34;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
      cells.push(cell);
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return null;

  // Calculate column widths
  const numCols = Math.max(...rows.map((r) => r.length));
  const widths = new Array(numCols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < numCols; i++) {
      widths[i] = Math.max(widths[i], row[i]?.length ?? 0);
    }
  }

  // Minimum column width
  const minW = 3;
  for (let i = 0; i < numCols; i++) {
    widths[i] = Math.max(widths[i], minW);
  }

  // Build ASCII table
  const pad = (s: string, w: number) => {
    const padLen = w - s.length;
    return s + " ".repeat(Math.max(0, padLen));
  };

  const separator = rows
    .map((_, i) => {
      const w = widths[i];
      return "-".repeat(w);
    })
    .join(" | ");

  const lines: string[] = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri] ?? [];
    const cells = row.map((c, i) => pad(c, widths[i])).join(" | ");
    lines.push(cells);
    // Insert separator after header row (first row)
    if (ri === 0 && rows.length > 1) {
      lines.push(separator);
    }
  }

  return lines.join("\n");
}

/**
 * Convert markdown to Matrix-compatible HTML with a plaintext fallback.
 * If the rendered HTML contains <table>, a column-aligned ASCII table
 * is generated as the `body` (plaintext) field, while the original HTML
 * is kept as `formatted_body`. This ensures Element X iOS (which doesn't
 * render <table>) still sees a readable representation.
 */
export function markdownToMatrixHtml(text: string): {
  html: string;
  plaintext: string;
} {
  const html = (marked.parse(text) as string).trimEnd();
  const ascii = htmlTableToAscii(html);
  return {
    html,
    plaintext: ascii ?? html.replace(/<[^>]+>/g, ""),
  };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Redact common secret-like substrings before showing tool args back to
 * the user. Matches `--api-key=…`, `Authorization: Bearer …`,
 * `password=…`, `token=…`, `--header "x-api-key: …"`, etc. The single-bot
 * Argos use case has self-talk privacy, but a careful default prevents
 * accidental disclosure when tool output gets quoted into other rooms.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // Authorization: Bearer xxxxx (HTTP header, with or without leading dashes)
      .replace(
        /(authorization\s*[:=]\s*(?:bearer|basic)\s+)\S+/gi,
        "$1<redacted>",
      )
      // --foo-key=value, --foo_token=value, password=value, etc.
      .replace(
        /((?:^|[\s"'-])(?:[\w-]*?(?:api[_-]?key|secret|token|password|bearer|auth))[=:\s]\s*)\S+/gi,
        "$1<redacted>",
      )
  );
}

/**
 * Build the args preview shown inside the running-tool block. Limits to
 * 80 chars, redacts secret-shaped substrings, and falls back gracefully
 * when args don't have a "natural" string representation per tool.
 */
export function buildArgsPreview(
  toolName: string,
  args: Record<string, unknown>,
): string {
  let raw: string;
  if (toolName === "Bash" && typeof args.command === "string") {
    raw = args.command;
  } else if (
    // ShellCommand / shell_command: `command` is a plain string
    (toolName === "ShellCommand" || toolName === "shell_command") &&
    typeof args.command === "string"
  ) {
    raw = args.command;
  } else if (
    // Shell / shell / RunShellCommand / run_shell_command: `command` is string[]
    (toolName === "Shell" ||
      toolName === "shell" ||
      toolName === "RunShellCommand" ||
      toolName === "run_shell_command") &&
    Array.isArray(args.command)
  ) {
    raw = (args.command as string[]).join(" ");
  } else if (
    (toolName === "Read" || toolName === "Write" || toolName === "Edit") &&
    typeof args.file_path === "string"
  ) {
    raw = args.file_path;
  } else if (toolName === "Glob" && typeof args.pattern === "string") {
    raw = args.pattern;
  } else if (toolName === "Grep" && typeof args.pattern === "string") {
    raw = args.pattern;
  } else {
    // Fallback: stringify whatever's there, single-line.
    raw = JSON.stringify(args).replace(/\s+/g, " ");
  }
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const redacted = redactSecrets(oneLine);
  return redacted.length > 80 ? `${redacted.slice(0, 79)}…` : redacted;
}

/**
 * Format ms as `m:ss` (e.g. `0:32`, `2:14`). Always two-digit seconds; the
 * minute count grows as needed without padding so the field doesn't shift
 * width across the 1-min boundary on phones that render edits in place.
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Compact token count: 48000 → "48K", 1_500_000 → "1.5M". */
export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** Sliding-window cap on the reasoning buffer when rendered to Matrix.
 *  The Matrix homeserver limit is 65 536 bytes per event after JSON
 *  encoding. Each finalize sends the buffer ~3× in the event payload
 *  (top-level body, m.new_content.body, HTML-escaped formatted_body),
 *  so we keep the raw character cap well below 65 536/3 to leave
 *  headroom for HTML escaping, the wrapper markup, the tool-status
 *  block, and the m.relates_to / m.new_content overhead. */
export const MATRIX_REASONING_MAX_CHARS = 12_000;
export const MATRIX_REASONING_TRUNCATION_NOTICE =
  "[…earlier reasoning truncated to fit Matrix size limit…]";

/** Returns the tail of `buffer` that fits inside the Matrix size budget,
 *  prefixed with a notice when truncation actually happened. We keep the
 *  *end* of the buffer because the most recent thinking is the most
 *  useful for the user watching live — earlier thoughts are usually
 *  already implied by what's on screen, the tool calls that ran, and
 *  the eventual answer message. */
export function clipReasoningForMatrix(buffer: string): string {
  if (buffer.length <= MATRIX_REASONING_MAX_CHARS) return buffer;
  const noticeWithSeparator = `${MATRIX_REASONING_TRUNCATION_NOTICE}\n\n`;
  const tail = buffer.slice(
    -(MATRIX_REASONING_MAX_CHARS - noticeWithSeparator.length),
  );
  return noticeWithSeparator + tail;
}

/** Trim text to the last whitespace boundary so streamed flushes end on
 *  a complete word. Returns the full input when no whitespace has yet
 *  appeared (initial post can't withhold all text), or when the text
 *  ends at a word boundary (trailing punctuation or alphanumeric at end
 *  of a sentence). */
export function wordBoundaryTrim(text: string): string {
  // If the text ends with trailing whitespace, strip it.
  if (/\s$/.test(text)) {
    return text.trimEnd();
  }
  // If the text ends with a letter or digit (mid-word), trim to last space.
  // Punctuation at end (. ! ? , ; : ) ] " ') signals a complete word/sentence.
  if (/[a-zA-Z0-9]$/.test(text)) {
    const lastSpace = text.search(/\s\S*$/);
    if (lastSpace <= 0) return text; // no whitespace or nothing before it
    return text.slice(0, lastSpace);
  }
  // Ends with punctuation or special char — treat as complete, return as-is.
  return text;
}

// ── Streaming-safe markdown helpers ──────────────────────────────────────────

/** Strip a trailing partial link/image syntax of the form `[label](something`
 *  where the closing paren hasn't arrived yet. Returns the input unchanged
 *  when no such trailing fragment exists. */
function stripTrailingPartialLink(text: string): string {
  // Match a [label]( with no closing ) afterwards.
  const m = text.match(/\[[^\]]*\]\([^)]*$/);
  if (!m) return text;
  return text.slice(0, m.index);
}

/** Strip a trailing `<` that opens a tag never closed. */
function stripTrailingPartialTag(text: string): string {
  const lt = text.lastIndexOf("<");
  if (lt === -1) return text;
  const after = text.slice(lt);
  if (after.includes(">")) return text; // closed
  return text.slice(0, lt);
}

/** Close any unclosed ``` triple-fence by appending one. */
function closeUnclosedFences(text: string): string {
  const fences = (text.match(/```/g) ?? []).length;
  if (fences % 2 === 1) return `${text}\n\`\`\``;
  return text;
}

/** Close any unclosed single-backtick inline code on the last line. */
function closeUnclosedInlineCode(text: string): string {
  const lines = text.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  // Count single backticks that aren't part of triple-backtick sequences.
  const singles = (lastLine.match(/(?<!`)`(?!`)/g) ?? []).length;
  if (singles % 2 === 1) return `${text}\``;
  return text;
}

/** Close unclosed bold and italic markers.
 *  Process double-markers before single so "**foo" closes properly. */
function closeUnclosedEmphasis(text: string): string {
  let s = text;
  // **bold**
  if ((s.match(/\*\*/g) ?? []).length % 2 === 1) s += "**";
  // __bold__
  if ((s.match(/__/g) ?? []).length % 2 === 1) s += "__";
  // single * — not adjacent to another *
  const singleStars = (s.match(/(?<!\*)\*(?!\*)/g) ?? []).length;
  if (singleStars % 2 === 1) s += "*";
  const singleUnders = (s.match(/(?<!_)_(?!_)/g) ?? []).length;
  if (singleUnders % 2 === 1) s += "_";
  return s;
}

/** Render partial markdown as Matrix HTML without producing broken output
 *  for fragments mid-stream. Pre-processes to close unclosed fences/
 *  emphasis and strip trailing partial link/tag syntax, then runs marked. */
export function streamingMarkdownToHtml(partial: string): {
  text: string;
  html: string;
} {
  let safe = partial;
  // Strip trailing partial tag/link FIRST (before counting emphasis markers).
  safe = stripTrailingPartialTag(safe);
  safe = stripTrailingPartialLink(safe);
  // Close structural markdown fragments.
  safe = closeUnclosedFences(safe);
  safe = closeUnclosedInlineCode(safe);
  safe = closeUnclosedEmphasis(safe);
  const { html, plaintext } = markdownToMatrixHtml(safe);
  return { html, text: plaintext };
}
