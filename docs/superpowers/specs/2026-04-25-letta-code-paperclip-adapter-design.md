# Letta Code Paperclip Adapter — Design Spec

**Date:** 2026-04-25
**Status:** Draft

## Overview

A standalone npm package (`@letta-ai/letta-code-paperclip-adapter`) that integrates Letta Code with Paperclip's agent orchestration platform. Paperclip spawns the `letta` CLI in headless mode to execute tasks, persisting conversation threads across wakeups so agents retain full context. The adapter lives in a separate repo (`../letta-code-paperclip-adapter`) and is loaded by Paperclip's external adapter plugin system.

Argos (the manager agent) creates tasks in Paperclip via its REST API directly — no adapter is needed on the Argos side. Paperclip then assigns those tasks to Letta Code agents via this adapter.

## Architecture

```
Argos (manager)
  └── POST /api/companies/{id}/issues → Paperclip REST API
                                            │
                               Paperclip orchestrator
                                            │
                               letta-code adapter (this package)
                                            │
                               letta CLI (--headless --output-format stream-json)
                                            │
                               Letta server (external, e.g. Argos Docker container)
```

The adapter is loaded at Paperclip server startup via the external adapter plugin system. It exports `createServerAdapter()` from its root entry point and a UI parser from `./ui-parser`.

## Package Structure

```
letta-code-paperclip-adapter/
  package.json
  tsconfig.json
  src/
    index.ts                # createServerAdapter(), type, label, models, agentConfigurationDoc
    server/
      execute.ts            # spawn letta CLI, session resume, unknown-conversation retry
      agent.ts              # lookup-or-create Letta agent by name via @letta-ai/letta-client
      parse.ts              # parse stream-json output → { conversationId, usage, summary, isError }
      test.ts               # testEnvironment: check letta binary, server reachability, agent config
    ui/
      parse-stdout.ts       # stream-json lines → TranscriptEntry[] for Paperclip run viewer
      index.ts              # ./ui-parser export
    skills/
      paperclip/
        SKILL.md            # teaches agents to call Paperclip issues API
```

**`package.json` exports:**
```json
{
  "name": "@letta-ai/letta-code-paperclip-adapter",
  "exports": {
    ".":           "./src/index.ts",
    "./ui-parser": "./src/ui/index.ts"
  }
}
```

No `./cli` export — CLI formatting is only supported by adapters inside the Paperclip monorepo.

## Adapter Configuration (`adapterConfig`)

Fields stored per Paperclip agent:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `lettaServerUrl` | string | yes | — | URL of the Letta server (e.g. `http://localhost:8283`) |
| `lettaApiKey` | string | no | — | API key for the Letta server |
| `agentName` | string | yes | — | Name of the Letta agent; looked up or created on first run |
| `model` | string | no | — | LLM model for agent creation (only used if agent doesn't exist yet) |
| `cwd` | string | yes | — | Working directory passed to the `letta` process |
| `promptTemplate` | string | no | default template | Paperclip wake prompt template |
| `timeoutSec` | number | no | `600` | Hard timeout for each run |
| `graceSec` | number | no | `15` | Grace period after SIGTERM before SIGKILL |
| `env` | object | no | `{}` | Additional environment variables injected into the `letta` process |

## Agent Lookup / Create (`server/agent.ts`)

On every run, before spawning the CLI, the adapter resolves the Letta agent identity:

1. Call `GET /v1/agents?name=<agentName>` via `@letta-ai/letta-client`
2. If found, use the returned `agent_id`
3. If not found, call `POST /v1/agents` with the configured `agentName` and `model`
4. Store `agentId` in `sessionParams` to avoid re-fetching on subsequent wakeups

The agent ID is always validated against the Letta server on the first wakeup; subsequent wakeups use the cached ID from `sessionParams` directly.

## CLI Invocation (`server/execute.ts`)

The adapter spawns:

```
letta --headless \
      --output-format stream-json \
      --agent <agentId> \
      [--conversation <conversationId>]  # only when resuming \
      [--model <model>] \
      [--max-turns <n>] \
      --skills <tmpSkillsDir>
```

The process is spawned with `cwd` set to the configured working directory. The prompt is passed via stdin.

Environment variables injected into the process:

| Variable | Source |
|----------|--------|
| `LETTA_BASE_URL` | `config.lettaServerUrl` |
| `LETTA_API_KEY` | `config.lettaApiKey` (if set) |
| `PAPERCLIP_AGENT_ID` | `agent.id` |
| `PAPERCLIP_COMPANY_ID` | `agent.companyId` |
| `PAPERCLIP_API_URL` | Paperclip server URL |
| `PAPERCLIP_API_KEY` | `authToken` (run JWT) |
| `PAPERCLIP_RUN_ID` | `runId` |
| `PAPERCLIP_TASK_ID` | `context.taskId` |
| `PAPERCLIP_WAKE_REASON` | `context.wakeReason` |
| `PAPERCLIP_APPROVAL_ID` | `context.approvalId` |
| `PAPERCLIP_APPROVAL_STATUS` | `context.approvalStatus` |

Plus any user-supplied `config.env` overrides.

**Skills injection:** At run time, a tmpdir is created with a `paperclip/SKILL.md` symlink pointing to the adapter package's `src/skills/paperclip/SKILL.md`. This tmpdir is passed as `--skills <tmpSkillsDir>` so letta-code discovers the Paperclip skill as a project-level skill source. The tmpdir is cleaned up in a `finally` block after the run.

## Session Management

Session state persisted per Paperclip task in `sessionParams`:

```ts
{
  conversationId: string;  // Letta conversation thread ID — resume key
  agentId: string;         // cached agent ID to skip re-lookup
  agentName: string;       // stored for cwd-mismatch log messages
  cwd: string;             // guard against cross-directory resume
}
```

**Resume logic:**
- Resume if `conversationId` is present and stored `cwd` matches current `cwd`
- If `cwd` changed, log a message and start a fresh conversation
- If the Letta server reports the conversation is not found, retry with a fresh conversation and return `clearSession: true`

**`sessionCodec`:**
- `serialize`: returns the above object
- `deserialize`: validates all fields are strings, returns null if any are missing
- `getDisplayId`: returns `conversationId`

## Output Parsing (`server/parse.ts`)

Letta Code emits newline-delimited JSON lines in stream-json mode, typed in `src/types/protocol.ts`. The parser scans stdout line by line:

| Event type | Action |
|------------|--------|
| `system / init` | Extract `conversation_id`, `agent_id` |
| `assistant` | Accumulate assistant text for summary |
| `result` | Extract usage (`input_tokens`, `output_tokens`, `cached_input_tokens`), `cost_usd`, final text |
| Other | Ignore |

Also exports `isLettaUnknownConversationError(stdout)` for the retry logic in `execute.ts`.

## UI Parser (`ui/parse-stdout.ts`)

Maps stream-json lines to `TranscriptEntry[]` for Paperclip's run viewer:

| Letta event | TranscriptEntry kind |
|-------------|----------------------|
| `system / init` | `init` (model, sessionId = conversationId) |
| `assistant` message | `assistant` (text) |
| `reasoning` message | `thinking` (text) |
| `tool_call` | `tool_call` (name, input) |
| `tool_return` | `tool_result` (content, isError) |
| `result` | `result` (usage, costUsd, isError) |
| Unparseable line | `stdout` (raw text) |

## Environment Test (`server/test.ts`)

`testEnvironment` runs preflight checks and returns structured diagnostics:

| Check | Code | Pass condition |
|-------|------|----------------|
| `letta` binary resolvable | `letta_binary` | `which letta` succeeds |
| `lettaServerUrl` configured | `server_url_configured` | Field is non-empty |
| Letta server reachable | `server_reachable` | `GET /v1/health` returns 200 |
| `agentName` configured | `agent_name_configured` | Field is non-empty |
| `cwd` is absolute and exists | `cwd_valid` | Path exists and is absolute |

Severity: missing binary or unreachable server → `error`; missing agent name or cwd → `error`; everything OK → `pass`.

## Paperclip Skill (`src/skills/paperclip/SKILL.md`)

A Letta Code skill that teaches agents how to create tasks in Paperclip:

- Trigger: when the agent needs to delegate work, create a sub-task, or report a blocker
- Content: `POST /api/companies/{PAPERCLIP_COMPANY_ID}/issues` with title, description, status, assigneeAgentId
- Auth: `Authorization: Bearer $PAPERCLIP_API_KEY` (injected by the adapter via env)
- Key env vars: `PAPERCLIP_API_URL`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_KEY`, `PAPERCLIP_TASK_ID` (parent issue ID)

## Argos Integration

No adapter is required. Argos creates Paperclip tasks by calling:

```
POST {PAPERCLIP_API_URL}/api/companies/{companyId}/issues
Authorization: Bearer <agent-api-key>
Content-Type: application/json

{
  "title": "...",
  "description": "...",
  "status": "todo",
  "priority": "medium",
  "assigneeAgentId": "<letta-code-agent-id>"
}
```

The agent API key is a long-lived credential configured in Argos's environment. The `assigneeAgentId` is the Paperclip agent ID for the target Letta Code worker (not the Letta agent ID).

## Error Handling

| Scenario | Handling |
|----------|----------|
| `letta` binary not found | `testEnvironment` catches it; `execute` logs and returns non-zero exit |
| Letta server unreachable | `testEnvironment` catches it; `execute` returns error with message |
| Unknown conversation on resume | Retry with fresh conversation, return `clearSession: true` |
| Process timeout | Return `timedOut: true`, no session clear |
| Non-zero exit, no parseable result | Return stderr first line as `errorMessage` |

## Out of Scope

- Remote execution (SSH, containers) — local only for now
- Letta server lifecycle management — always external
- CLI formatter (`./cli` export) — monorepo-only feature
- Bedrock / alternative LLM provider routing — Letta handles model config server-side
