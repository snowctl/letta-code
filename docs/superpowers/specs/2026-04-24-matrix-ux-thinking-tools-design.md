# Matrix UX: Thinking Block Ordering & Tool Block Formatting

**Date:** 2026-04-24  
**Scope:** Matrix adapter only (`src/channels/matrix/adapter.ts`, `src/channels/tool-block.ts`)

## Problem

Two UX issues with the Matrix channel adapter:

1. The thinking block renders **after** the tool calls block when the agent calls tools before reasoning chunks arrive at the adapter. The desired order is: thinking → tools → response.
2. The tool block uses bullet characters (`•`) for each tool. The desired format is plain newline-separated lines with `(xN)` for counts.

## Design

### 1. Thinking Message Lifecycle

**Sending the placeholder:**  
A `▶ Thinking...` placeholder message is sent to the Matrix room before any tool block message is queued. Whichever event arrives first — the first reasoning chunk or the first tool call — triggers the placeholder to be sent (if it hasn't been sent yet). This guarantees the thinking message always occupies a position above the tool block in the chat timeline.

**Streaming content:**  
As reasoning chunks arrive, the thinking message is updated in place via `m.replace` edits. The flush interval is reduced from 500ms to 150ms. The actual visible update rate is subject to the Matrix homeserver's rate limiting on edits; failed flushes are logged and retried on the next interval tick (current behaviour, unchanged).

**At turn end — with response:**  
1. Stop the flush interval.  
2. **Delete** the thinking message from the room (`m.room.redaction`).  
3. **Send** the agent's response as a new message in the format:
   ```
   <details><summary>Thinking</summary>
   {reasoning content}
   </details>
   <hr>
   {response text}
   ```
   If no reasoning content was accumulated (placeholder was sent but never populated), send the response as plain text with no thinking drawer.

**At turn end — no response (messagechannel tool not used):**  
Delete the thinking message silently. The tool block (if any) remains in the room.

**State management:**  
Reuses the existing `reasoningMessageIdByChatId` and `reasoningBufferByChatId` maps. Adds a flag or sentinel to distinguish "placeholder sent, no content yet" from "content has been accumulated" so the response handler knows whether to embed a thinking drawer.

### 2. Tool Block Ordering Guarantee

`scheduleToolBlockUpdate` is the function that sends/updates the tool block message. Before queuing the first tool block send, it checks whether a thinking placeholder already exists for the chat. If not, it sends the placeholder first (synchronously within the operation queue), then sends the tool block. This ensures the thinking message is always above the tool block in the timeline regardless of whether reasoning chunks have arrived yet.

### 3. Tool Block Formatting

**Current format:**
```
🔧 Tools used:
• memory ×2
• fetch
```

**New format:**
```
🔧 Tools used:
memory (x2)
fetch
```

Changes in `renderToolBlock` in `src/channels/tool-block.ts`:
- Remove the `•` bullet prefix from each line.
- Change count notation from `×N` to `(xN)`.

### Final Chat Timeline

**Turn with tools and reasoning:**
```
During processing:
  [Thinking... (streams in)]
  [🔧 Tools used: ... (updates as tools run)]

After response arrives:
  [🔧 Tools used: memory (x2) / fetch]     ← persists
  [▶ Thinking                               ← new message (response)
     {reasoning}
   ───
   {response text}]
```

**Turn with reasoning, no tools:**
```
During processing:
  [Thinking... (streams in)]

After response arrives:
  [▶ Thinking                               ← new message (response)
     {reasoning}
   ───
   {response text}]
```

**Turn with no response:**
```
  [🔧 Tools used: ...]                      ← persists
  (thinking message deleted, nothing else)
```

## Out of Scope

- Telegram adapter (no changes).
- Reducing Matrix homeserver rate limits on `m.replace` — this is server configuration outside the adapter.
- Changing the collapsible `<details>` format of the thinking drawer.
