# Assistant Text Auto-Forward Design

**Date:** 2026-04-26
**Status:** Draft

## Problem

The current model requires the agent to call `MessageChannel` for every reply to a channel user. This inverts the natural speech model — the tool becomes the primary response mechanism rather than a side-effect surface. It adds cognitive overhead (the agent must always remember to call the tool), wastes tokens on tool call scaffolding, and makes it harder for the agent to reason about when to stay silent.

## Proposed Model

Shift to "speech-as-primary-response, tools-as-side-effects":

| Run type | How agent replies | Tool surface |
|---|---|---|
| Interactive (inbound channel message) | `assistant_text` auto-forwards to originating chat | `ChannelAction` for side-effects |
| Scheduled / quiet run | No auto-forward | `NotifyUser` required to reach anyone |

**Silence in interactive runs:** the agent produces no `assistant_text`. A tool-only turn (e.g. only `ChannelAction` called) is also silent from the user's perspective — no text message is delivered.

## Tool: `ChannelAction`

Replaces `MessageChannel` for interactive side-effect actions. Used when the agent wants to do something beyond its natural reply.

**Actions:**
- `react` — add or remove a reaction emoji on the inbound message
- `edit` — edit the agent's most recently sent message in this conversation
- `thread-reply` — send a reply into a specific thread
- `upload` — upload a file to the channel

**Context resolution (internal — agent does not supply these):**
- `channel`, `chat_id`, `thread_id` — resolved from the current inbound turn context
- Last sent message ID (for `edit`) — resolved from channel adapter per-conversation state; the agent always edits its most recent message, multi-turn targeting is not supported

**Agent-supplied params (action-dependent):**
- `react`: `message_id` (inbound message to react to), `emoji`, `remove` (bool)
- `edit`: `text` (new message text)
- `thread-reply`: `thread_id` (optional override — defaults to the inbound thread; supply a different ID to reply into a thread other than the one the agent was addressed in), `text`
- `upload`: `file_path` or `url`, `caption` (optional)

## Tool: `NotifyUser`

Used exclusively in scheduled and quiet runs. No inbound context exists, so all targeting is explicit.

**Params:**
- `channel` — channel platform identifier
- `chat_id` — target chat or room
- `thread_id` — optional thread to reply into
- `message` — text to send

The scheduler injects available targets (channel + chat_id pairs the agent has access to) into the cron system-reminder so the agent knows where it can reach people.

## Auto-Forward Mechanics

When a turn completes in an interactive run and `assistant_text` was produced:

1. The turn listener passes the final text and the inbound `channelSources` to the channel registry
2. The registry dispatches to each matching channel adapter's `handleAutoForward(text, sources)` method
3. The adapter sends the message and stores the sent message ID in per-conversation state (for future `edit` actions)
4. No delivery receipt is injected into context — agents that need to edit a previous message always target the most recently sent one, resolved internally

## Changes Required

### `src/tools/impl/MessageChannel.ts` → `src/tools/impl/ChannelAction.ts`
- Rename tool, remove `send` action (no longer needed — covered by auto-forward)
- Remove agent-supplied `channel` / `chat_id` params; resolve from inbound context
- Add internal resolution of last sent message ID for `edit` action
- Retain: `react`, `edit`, `thread-reply`, `upload`

### New: `src/tools/impl/NotifyUser.ts`
- New tool with explicit `channel`, `chat_id`, `thread_id`, `message` params
- Only registered/available during scheduled/cron runs — `ChannelAction` is not available in these runs since there is no inbound context to resolve from
- Schema built from active channel registry (valid `channel` enum)

### `src/tools/toolDefinitions.ts`
- Replace `MessageChannel` registration with `ChannelAction`
- Add conditional registration of `NotifyUser` for cron runs

### `src/websocket/listener/turn.ts`
- After turn completes, if `assistant_text` was produced and `channelSources` are present, call `registry.handleAutoForward(text, sources)`
- Remove any existing logic that required `MessageChannel` to be called for delivery

### `src/channels/registry.ts`
- Add `handleAutoForward(text, sources)` dispatch method
- Channel adapters implement `handleAutoForward(text, sources)` returning sent message ID
- Per-conversation last-sent-message-id stored in adapter state

### `src/channels/xml.ts` — Inbound XML reminder
Remove the "You MUST respond via the `MessageChannel` tool" Response Directives section. Replace with:

```
**Responding:**
- Your response text is delivered to the user automatically — just write your reply
- To stay silent, produce no response text
- Use `ChannelAction` for reactions, edits, or thread-specific replies
```

### `src/cron/scheduler.ts` — Cron system-reminder
Add a quiet-run section to the wrapped prompt:

```
**Quiet run — no inbound message:**
You are running on a schedule with no user present. Your response text is NOT delivered automatically.
Use `NotifyUser` to reach a user. Available targets:
- channel: <channel>, chat_id: <chat_id>
```

### System prompt
Update global agent system prompt to reflect the new model: response text is primary, tools are side-effects, `NotifyUser` is for proactive outreach.

## What Does Not Change

- Streaming layer (`dispatchStreamText`, `dispatchStreamReasoning`) — still operates as-is for live in-place message previews during a turn; `handleAutoForward` is the final committed send that happens after the turn completes, not a duplicate of the stream
- Turn lifecycle events (queued/started/finished/cancelled) — unchanged
- Operator commands (`!reset`, `!cancel`, etc.) — unchanged
- Channel adapter plugin interface for non-message features — unchanged
