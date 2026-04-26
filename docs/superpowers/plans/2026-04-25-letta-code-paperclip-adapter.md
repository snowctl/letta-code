# Letta Code Paperclip Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone npm package that lets Paperclip orchestrate Letta Code agents — spawning `letta -p` in headless stream-json mode, persisting conversation threads per task, and injecting a Paperclip skill so agents can create issues.

**Architecture:** External Paperclip adapter package (`@letta-ai/letta-code-paperclip-adapter`) loaded via Paperclip's plugin system. Spawns the `letta` CLI with `-p --output-format stream-json`, passes prompt via the `-p` argument, parses NDJSON stdout into structured results. Session state (conversation ID + agent ID) is persisted in Paperclip's `sessionParams` per task so agents resume the same conversation thread across wakeups.

**Tech Stack:** TypeScript, Bun (runtime + test runner), `@paperclipai/adapter-utils` (types + server-utils), `@letta-ai/letta-client` (Letta API), `@letta-ai/letta-code` (protocol types)

> **Note:** This plan implements a new repo at `../letta-code-paperclip-adapter` (sibling to `letta-code`). All file paths below are relative to that new repo root.

---

## File Map

| File | Responsibility |
|------|---------------|
| `package.json` | Package metadata, exports (`.` and `./ui-parser`), dependencies |
| `tsconfig.json` | TypeScript config targeting ES2022 modules |
| `src/index.ts` | `createServerAdapter()` entry point, adapter metadata |
| `src/server/parse.ts` | Parse stream-json stdout → `ParsedLettaOutput`; `isLettaUnknownConversationError` |
| `src/server/session.ts` | `sessionCodec` (serialize / deserialize / getDisplayId) |
| `src/server/agent.ts` | Lookup-or-create Letta agent by name via `@letta-ai/letta-client` |
| `src/server/test.ts` | `testEnvironment` preflight checks |
| `src/server/execute.ts` | Main execution: spawn CLI, inject env, handle retry, return result |
| `src/ui/parse-stdout.ts` | Stream-json lines → `TranscriptEntry[]` for Paperclip run viewer |
| `src/ui/index.ts` | `./ui-parser` export |
| `src/skills/paperclip/SKILL.md` | Skill teaching agents to create Paperclip issues |
| `src/tests/parse.test.ts` | Unit tests for `parse.ts` |
| `src/tests/session.test.ts` | Unit tests for `session.ts` |
| `src/tests/agent.test.ts` | Unit tests for `agent.ts` |
| `src/tests/test-env.test.ts` | Unit tests for `test.ts` |
| `src/tests/ui-parser.test.ts` | Unit tests for `ui/parse-stdout.ts` |

---

## Task 1: Initialize the repo

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/` directory structure

- [ ] **Step 1: Create the repo**

```bash
mkdir ../letta-code-paperclip-adapter
cd ../letta-code-paperclip-adapter
git init
mkdir -p src/server src/ui src/tests src/skills/paperclip
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "@letta-ai/letta-code-paperclip-adapter",
  "version": "0.1.0",
  "description": "Paperclip adapter for Letta Code agents",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./ui-parser": "./src/ui/index.ts"
  },
  "files": [
    "src"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/letta-ai/letta-code-paperclip-adapter.git"
  },
  "license": "Apache-2.0",
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "@letta-ai/letta-client": "^1.10.2",
    "@letta-ai/letta-code": "^0.24.0",
    "@paperclipai/adapter-utils": "2026.416.0"
  },
  "devDependencies": {
    "typescript": "^5.7.3",
    "@types/bun": "^1.3.7"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test src/tests"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["bun-types"]
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
dist/
*.js.map
.env
.env.*
```

- [ ] **Step 5: Install dependencies**

```bash
bun install
```

Expected: `node_modules/` created, `bun.lock` written.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore bun.lock
git commit -m "chore: initialize letta-code-paperclip-adapter package"
```

---

## Task 2: Output parser (`src/server/parse.ts`)

The parser reads newline-delimited JSON from the `letta` process stdout. All content messages have `type: "message"`. The `system/init` event carries `conversation_id`. The `result` event carries usage and the final text.

**Files:**
- Create: `src/server/parse.ts`
- Create: `src/tests/parse.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tests/parse.test.ts
import { describe, expect, test } from "bun:test";
import { parseLettaOutput, isLettaUnknownConversationError } from "../server/parse";

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess-1",
  uuid: "u1",
  agent_id: "agent-abc",
  conversation_id: "conv-xyz",
  model: "gpt-4o",
  tools: [],
  cwd: "/tmp",
  mcp_servers: [],
  permission_mode: "auto",
  slash_commands: [],
});

const ASSISTANT_LINE = JSON.stringify({
  type: "message",
  message_type: "assistant_message",
  session_id: "sess-1",
  uuid: "u2",
  agent_id: "agent-abc",
  conversation_id: "conv-xyz",
  text: "I will complete the task.",
});

const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "sess-1",
  uuid: "u3",
  agent_id: "agent-abc",
  conversation_id: "conv-xyz",
  duration_ms: 2000,
  duration_api_ms: 1800,
  num_turns: 2,
  result: "Done.",
  run_ids: ["run-1"],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
});

const UNKNOWN_CONV_ERROR_LINE = JSON.stringify({
  type: "error",
  message: "Conversation conv-999 not found",
  stop_reason: "error",
  session_id: "sess-err",
  uuid: "u-err",
  agent_id: "agent-abc",
  conversation_id: "conv-999",
});

describe("parseLettaOutput", () => {
  test("extracts conversationId and agentId from system/init", () => {
    const result = parseLettaOutput([INIT_LINE, RESULT_LINE].join("\n"));
    expect(result.conversationId).toBe("conv-xyz");
    expect(result.agentId).toBe("agent-abc");
  });

  test("extracts model from system/init", () => {
    const result = parseLettaOutput([INIT_LINE, RESULT_LINE].join("\n"));
    expect(result.model).toBe("gpt-4o");
  });

  test("accumulates assistant text as summary", () => {
    const result = parseLettaOutput([INIT_LINE, ASSISTANT_LINE, RESULT_LINE].join("\n"));
    expect(result.summary).toBe("Done.");
  });

  test("falls back to assistant text if result.result is null", () => {
    const resultLineNoText = JSON.stringify({
      ...JSON.parse(RESULT_LINE),
      result: null,
    });
    const result = parseLettaOutput([INIT_LINE, ASSISTANT_LINE, resultLineNoText].join("\n"));
    expect(result.summary).toBe("I will complete the task.");
  });

  test("extracts usage tokens from result", () => {
    const result = parseLettaOutput([INIT_LINE, RESULT_LINE].join("\n"));
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
  });

  test("isError is false for success subtype", () => {
    const result = parseLettaOutput([INIT_LINE, RESULT_LINE].join("\n"));
    expect(result.isError).toBe(false);
  });

  test("isError is true for error subtype", () => {
    const errorResult = JSON.stringify({ ...JSON.parse(RESULT_LINE), subtype: "error" });
    const result = parseLettaOutput([INIT_LINE, errorResult].join("\n"));
    expect(result.isError).toBe(true);
  });

  test("handles empty stdout gracefully", () => {
    const result = parseLettaOutput("");
    expect(result.conversationId).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.isError).toBe(false);
  });

  test("skips unparseable lines", () => {
    const stdout = [INIT_LINE, "not json", RESULT_LINE].join("\n");
    const result = parseLettaOutput(stdout);
    expect(result.conversationId).toBe("conv-xyz");
  });
});

describe("isLettaUnknownConversationError", () => {
  test("returns true when error message mentions conversation not found", () => {
    expect(isLettaUnknownConversationError(UNKNOWN_CONV_ERROR_LINE)).toBe(true);
  });

  test("returns false for normal output", () => {
    expect(isLettaUnknownConversationError([INIT_LINE, RESULT_LINE].join("\n"))).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isLettaUnknownConversationError("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/tests/parse.test.ts
```

Expected: `FAIL` — `Cannot find module '../server/parse'`

- [ ] **Step 3: Implement `src/server/parse.ts`**

```typescript
import type { UsageSummary } from "@paperclipai/adapter-utils";

export interface ParsedLettaOutput {
  conversationId: string | null;
  agentId: string | null;
  model: string;
  summary: string;
  usage: UsageSummary | null;
  isError: boolean;
  resultJson: Record<string, unknown> | null;
}

function safeParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function asStr(val: unknown, fallback = ""): string {
  return typeof val === "string" ? val : fallback;
}

function asNum(val: unknown, fallback = 0): number {
  return typeof val === "number" && Number.isFinite(val) ? val : fallback;
}

export function parseLettaOutput(stdout: string): ParsedLettaOutput {
  let conversationId: string | null = null;
  let agentId: string | null = null;
  let model = "";
  let resultJson: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = safeParseJson(line);
    if (!event) continue;

    const type = asStr(event.type);

    if (type === "system" && asStr(event.subtype) === "init") {
      conversationId = asStr(event.conversation_id) || conversationId;
      agentId = asStr(event.agent_id) || agentId;
      model = asStr(event.model) || model;
      continue;
    }

    if (type === "message") {
      // All content messages share type="message"; discriminate by message_type
      const msgType = asStr(event.message_type);
      if (msgType === "assistant_message") {
        const text = asStr(event.text);
        if (text) assistantTexts.push(text);
      }
      // Keep conversationId fresh from any message envelope
      conversationId = asStr(event.conversation_id) || conversationId;
      agentId = asStr(event.agent_id) || agentId;
      continue;
    }

    if (type === "result") {
      resultJson = event;
      conversationId = asStr(event.conversation_id) || conversationId;
      agentId = asStr(event.agent_id) || agentId;
      continue;
    }
  }

  if (!resultJson) {
    return {
      conversationId,
      agentId,
      model,
      summary: assistantTexts.join("\n\n").trim(),
      usage: null,
      isError: false,
      resultJson: null,
    };
  }

  const rawUsage = resultJson.usage;
  const usage: UsageSummary | null =
    rawUsage !== null && typeof rawUsage === "object" && !Array.isArray(rawUsage)
      ? {
          inputTokens: asNum((rawUsage as Record<string, unknown>).prompt_tokens),
          outputTokens: asNum((rawUsage as Record<string, unknown>).completion_tokens),
          cachedInputTokens: asNum((rawUsage as Record<string, unknown>).cache_read_input_tokens),
        }
      : null;

  const resultText = typeof resultJson.result === "string" ? resultJson.result.trim() : "";
  const summary = resultText || assistantTexts.join("\n\n").trim();
  const isError = asStr(resultJson.subtype) === "error";

  return { conversationId, agentId, model, summary, usage, isError, resultJson };
}

const UNKNOWN_CONV_RE = /conversation\s+\S+\s+not\s+found|unknown\s+conversation|no\s+conversation\s+found/i;

export function isLettaUnknownConversationError(stdout: string): boolean {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = safeParseJson(line);
    if (!event) continue;
    if (asStr(event.type) === "error") {
      const msg = asStr(event.message);
      if (UNKNOWN_CONV_RE.test(msg)) return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/tests/parse.test.ts
```

Expected: all tests `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/server/parse.ts src/tests/parse.test.ts
git commit -m "feat: add stream-json output parser"
```

---

## Task 3: Session codec (`src/server/session.ts`)

**Files:**
- Create: `src/server/session.ts`
- Create: `src/tests/session.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tests/session.test.ts
import { describe, expect, test } from "bun:test";
import { sessionCodec } from "../server/session";

const VALID_PARAMS = {
  conversationId: "conv-abc",
  agentId: "agent-123",
  agentName: "dev-worker",
  cwd: "/home/user/project",
};

describe("sessionCodec.serialize", () => {
  test("returns the params object as-is when all fields present", () => {
    expect(sessionCodec.serialize(VALID_PARAMS)).toEqual(VALID_PARAMS);
  });

  test("returns null when params is null", () => {
    expect(sessionCodec.serialize(null)).toBeNull();
  });
});

describe("sessionCodec.deserialize", () => {
  test("returns params when all required fields are strings", () => {
    const result = sessionCodec.deserialize(VALID_PARAMS);
    expect(result).toEqual(VALID_PARAMS);
  });

  test("returns null when conversationId is missing", () => {
    const { conversationId: _, ...rest } = VALID_PARAMS;
    expect(sessionCodec.deserialize(rest)).toBeNull();
  });

  test("returns null when agentId is missing", () => {
    const { agentId: _, ...rest } = VALID_PARAMS;
    expect(sessionCodec.deserialize(rest)).toBeNull();
  });

  test("returns null when cwd is missing", () => {
    const { cwd: _, ...rest } = VALID_PARAMS;
    expect(sessionCodec.deserialize(rest)).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize("string")).toBeNull();
    expect(sessionCodec.deserialize(42)).toBeNull();
  });
});

describe("sessionCodec.getDisplayId", () => {
  test("returns conversationId", () => {
    expect(sessionCodec.getDisplayId?.(VALID_PARAMS)).toBe("conv-abc");
  });

  test("returns null when params is null", () => {
    expect(sessionCodec.getDisplayId?.(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/tests/session.test.ts
```

Expected: `FAIL` — `Cannot find module '../server/session'`

- [ ] **Step 3: Implement `src/server/session.ts`**

```typescript
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export interface LettaSessionParams {
  conversationId: string;
  agentId: string;
  agentName: string;
  cwd: string;
}

function isString(val: unknown): val is string {
  return typeof val === "string" && val.length > 0;
}

function deserializeLettaSession(raw: unknown): LettaSessionParams | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (!isString(obj.conversationId)) return null;
  if (!isString(obj.agentId)) return null;
  if (!isString(obj.cwd)) return null;
  return {
    conversationId: obj.conversationId as string,
    agentId: obj.agentId as string,
    agentName: typeof obj.agentName === "string" ? obj.agentName : "",
    cwd: obj.cwd as string,
  };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    return deserializeLettaSession(raw);
  },

  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) return null;
    return params;
  },

  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) return null;
    return typeof params.conversationId === "string" ? params.conversationId : null;
  },
};

export function readSessionParams(raw: unknown): LettaSessionParams | null {
  return deserializeLettaSession(raw);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/tests/session.test.ts
```

Expected: all tests `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/server/session.ts src/tests/session.test.ts
git commit -m "feat: add session codec for conversation-per-task persistence"
```

---

## Task 4: Agent lookup/create (`src/server/agent.ts`)

**Files:**
- Create: `src/server/agent.ts`
- Create: `src/tests/agent.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tests/agent.test.ts
import { describe, expect, test, mock } from "bun:test";
import { resolveAgent } from "../server/agent";

// Minimal AgentState shape we depend on
const EXISTING_AGENT = { id: "agent-existing", name: "dev-worker" };
const CREATED_AGENT = { id: "agent-new", name: "dev-worker" };

describe("resolveAgent", () => {
  test("returns existing agent id when agent is found by name", async () => {
    const listAgents = mock(async () => [EXISTING_AGENT]);
    const createAgent = mock(async () => CREATED_AGENT);
    const result = await resolveAgent({
      agentName: "dev-worker",
      model: "",
      listAgents,
      createAgent,
    });
    expect(result).toBe("agent-existing");
    expect(createAgent).not.toHaveBeenCalled();
  });

  test("creates agent when none found and returns new id", async () => {
    const listAgents = mock(async () => []);
    const createAgent = mock(async () => CREATED_AGENT);
    const result = await resolveAgent({
      agentName: "dev-worker",
      model: "gpt-4o",
      listAgents,
      createAgent,
    });
    expect(result).toBe("agent-new");
    expect(createAgent).toHaveBeenCalledWith({ name: "dev-worker", model: "gpt-4o" });
  });

  test("picks first match when multiple agents share a name", async () => {
    const listAgents = mock(async () => [
      { id: "agent-first", name: "dev-worker" },
      { id: "agent-second", name: "dev-worker" },
    ]);
    const createAgent = mock(async () => CREATED_AGENT);
    const result = await resolveAgent({
      agentName: "dev-worker",
      model: "",
      listAgents,
      createAgent,
    });
    expect(result).toBe("agent-first");
  });

  test("creates agent without model when model is empty string", async () => {
    const listAgents = mock(async () => []);
    const createAgent = mock(async () => CREATED_AGENT);
    await resolveAgent({ agentName: "dev-worker", model: "", listAgents, createAgent });
    expect(createAgent).toHaveBeenCalledWith({ name: "dev-worker" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/tests/agent.test.ts
```

Expected: `FAIL` — `Cannot find module '../server/agent'`

- [ ] **Step 3: Implement `src/server/agent.ts`**

The real implementation wraps `@letta-ai/letta-client`. Tests inject the Letta API calls as dependencies so we avoid needing a live Letta server in unit tests.

```typescript
import { LettaClient } from "@letta-ai/letta-client";

export interface ResolveAgentDeps {
  agentName: string;
  model: string;
  listAgents: (opts: { name: string }) => Promise<Array<{ id: string; name: string }>>;
  createAgent: (opts: { name: string; model?: string }) => Promise<{ id: string }>;
}

export async function resolveAgent(deps: ResolveAgentDeps): Promise<string> {
  const { agentName, model, listAgents, createAgent } = deps;
  const existing = await listAgents({ name: agentName });
  if (existing.length > 0 && existing[0]) {
    return existing[0].id;
  }
  const createOpts: { name: string; model?: string } = { name: agentName };
  if (model) createOpts.model = model;
  const created = await createAgent(createOpts);
  return created.id;
}

export function makeLettaAgentDeps(
  serverUrl: string,
  apiKey: string | undefined,
  agentName: string,
  model: string,
): ResolveAgentDeps {
  const client = new LettaClient({
    baseUrl: serverUrl,
    ...(apiKey ? { token: apiKey } : {}),
  });
  return {
    agentName,
    model,
    listAgents: (opts) => client.agents.list({ name: opts.name }),
    createAgent: (opts) => client.agents.create({ name: opts.name, ...(opts.model ? { llmConfig: { model: opts.model } } : {}) }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/tests/agent.test.ts
```

Expected: all tests `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/server/agent.ts src/tests/agent.test.ts
git commit -m "feat: add Letta agent lookup-or-create"
```

---

## Task 5: Environment test (`src/server/test.ts`)

**Files:**
- Create: `src/server/test.ts`
- Create: `src/tests/test-env.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tests/test-env.test.ts
import { describe, expect, test } from "bun:test";
import { runEnvironmentChecks } from "../server/test";

describe("runEnvironmentChecks", () => {
  test("returns error check when lettaServerUrl is empty", async () => {
    const result = await runEnvironmentChecks({
      lettaServerUrl: "",
      agentName: "dev-worker",
      cwd: "/tmp",
      checkBinary: async () => true,
      checkServerReachable: async () => true,
      checkPathExists: async () => true,
    });
    const check = result.checks.find((c) => c.code === "server_url_configured");
    expect(check?.level).toBe("error");
    expect(result.status).toBe("fail");
  });

  test("returns error check when letta binary not found", async () => {
    const result = await runEnvironmentChecks({
      lettaServerUrl: "http://localhost:8283",
      agentName: "dev-worker",
      cwd: "/tmp",
      checkBinary: async () => false,
      checkServerReachable: async () => true,
      checkPathExists: async () => true,
    });
    const check = result.checks.find((c) => c.code === "letta_binary");
    expect(check?.level).toBe("error");
    expect(result.status).toBe("fail");
  });

  test("returns error check when server unreachable", async () => {
    const result = await runEnvironmentChecks({
      lettaServerUrl: "http://localhost:8283",
      agentName: "dev-worker",
      cwd: "/tmp",
      checkBinary: async () => true,
      checkServerReachable: async () => false,
      checkPathExists: async () => true,
    });
    const check = result.checks.find((c) => c.code === "server_reachable");
    expect(check?.level).toBe("error");
    expect(result.status).toBe("fail");
  });

  test("returns error when agentName is empty", async () => {
    const result = await runEnvironmentChecks({
      lettaServerUrl: "http://localhost:8283",
      agentName: "",
      cwd: "/tmp",
      checkBinary: async () => true,
      checkServerReachable: async () => true,
      checkPathExists: async () => true,
    });
    const check = result.checks.find((c) => c.code === "agent_name_configured");
    expect(check?.level).toBe("error");
  });

  test("returns error when cwd does not exist", async () => {
    const result = await runEnvironmentChecks({
      lettaServerUrl: "http://localhost:8283",
      agentName: "dev-worker",
      cwd: "/tmp",
      checkBinary: async () => true,
      checkServerReachable: async () => true,
      checkPathExists: async () => false,
    });
    const check = result.checks.find((c) => c.code === "cwd_valid");
    expect(check?.level).toBe("error");
  });

  test("returns pass status when all checks pass", async () => {
    const result = await runEnvironmentChecks({
      lettaServerUrl: "http://localhost:8283",
      agentName: "dev-worker",
      cwd: "/tmp",
      checkBinary: async () => true,
      checkServerReachable: async () => true,
      checkPathExists: async () => true,
    });
    expect(result.status).toBe("pass");
    expect(result.checks.every((c) => c.level === "info")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/tests/test-env.test.ts
```

Expected: `FAIL` — `Cannot find module '../server/test'`

- [ ] **Step 3: Implement `src/server/test.ts`**

```typescript
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";

interface EnvironmentCheckDeps {
  lettaServerUrl: string;
  agentName: string;
  cwd: string;
  checkBinary: () => Promise<boolean>;
  checkServerReachable: () => Promise<boolean>;
  checkPathExists: () => Promise<boolean>;
}

export async function runEnvironmentChecks(
  deps: EnvironmentCheckDeps,
): Promise<{ status: "pass" | "warn" | "fail"; checks: AdapterEnvironmentCheck[] }> {
  const checks: AdapterEnvironmentCheck[] = [];

  // 1. letta binary
  const binaryOk = await deps.checkBinary();
  checks.push({
    code: "letta_binary",
    level: binaryOk ? "info" : "error",
    message: binaryOk ? "`letta` binary found" : "`letta` binary not found in PATH",
    hint: binaryOk ? undefined : "Install letta-code: npm install -g @letta-ai/letta-code",
  });

  // 2. Server URL configured
  const urlOk = deps.lettaServerUrl.trim().length > 0;
  checks.push({
    code: "server_url_configured",
    level: urlOk ? "info" : "error",
    message: urlOk ? `Letta server URL configured: ${deps.lettaServerUrl}` : "`lettaServerUrl` is required",
  });

  // 3. Server reachable (only if URL is present)
  if (urlOk) {
    const reachable = await deps.checkServerReachable();
    checks.push({
      code: "server_reachable",
      level: reachable ? "info" : "error",
      message: reachable
        ? `Letta server reachable at ${deps.lettaServerUrl}`
        : `Cannot reach Letta server at ${deps.lettaServerUrl}`,
      hint: reachable ? undefined : "Ensure the Letta server is running and the URL is correct",
    });
  }

  // 4. Agent name configured
  const agentOk = deps.agentName.trim().length > 0;
  checks.push({
    code: "agent_name_configured",
    level: agentOk ? "info" : "error",
    message: agentOk ? `Agent name configured: ${deps.agentName}` : "`agentName` is required",
  });

  // 5. cwd valid
  const cwdOk = path.isAbsolute(deps.cwd) && (await deps.checkPathExists());
  checks.push({
    code: "cwd_valid",
    level: cwdOk ? "info" : "error",
    message: cwdOk
      ? `Working directory exists: ${deps.cwd}`
      : `Working directory invalid or does not exist: ${deps.cwd || "(empty)"}`,
    hint: cwdOk ? undefined : "Set `cwd` to an absolute path that exists on the host",
  });

  const hasError = checks.some((c) => c.level === "error");
  const hasWarn = checks.some((c) => c.level === "warn");
  const status = hasError ? "fail" : hasWarn ? "warn" : "pass";
  return { status, checks };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const { config } = ctx;
  const lettaServerUrl = asString(config.lettaServerUrl, "");
  const agentName = asString(config.agentName, "");
  const cwd = asString(config.cwd, "");

  const checkBinary = async () => {
    try {
      const proc = Bun.spawn(["which", "letta"], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  };

  const checkServerReachable = async () => {
    try {
      const res = await fetch(`${lettaServerUrl}/v1/health`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  };

  const checkPathExists = async () => {
    if (!path.isAbsolute(cwd)) return false;
    try {
      const stat = await fs.stat(cwd);
      return stat.isDirectory();
    } catch {
      return false;
    }
  };

  const { status, checks } = await runEnvironmentChecks({
    lettaServerUrl,
    agentName,
    cwd,
    checkBinary,
    checkServerReachable,
    checkPathExists,
  });

  return {
    adapterType: "letta_code",
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/tests/test-env.test.ts
```

Expected: all tests `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/server/test.ts src/tests/test-env.test.ts
git commit -m "feat: add testEnvironment preflight checks"
```

---

## Task 6: Execute (`src/server/execute.ts`)

**Files:**
- Create: `src/server/execute.ts`

No unit tests for `execute.ts` — it spawns a real process and wraps all the other modules. Correctness is validated by the modules it delegates to (parse, session, agent) and by manual/integration testing. Write a type-check-only smoke test.

- [ ] **Step 1: Write a type-check smoke test**

```typescript
// src/tests/execute.test.ts
import { describe, test } from "bun:test";
// This file only checks that execute.ts compiles and exports the right shape.
import { execute } from "../server/execute";

describe("execute export", () => {
  test("execute is a function", () => {
    // Runtime presence check — actual execution requires a live letta server
    if (typeof execute !== "function") throw new Error("execute must be a function");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test src/tests/execute.test.ts
```

Expected: `FAIL` — `Cannot find module '../server/execute'`

- [ ] **Step 3: Implement `src/server/execute.ts`**

```typescript
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  parseObject,
  buildPaperclipEnv,
  runChildProcess,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { makeLettaAgentDeps, resolveAgent } from "./agent.js";
import { parseLettaOutput, isLettaUnknownConversationError } from "./parse.js";
import { readSessionParams } from "./session.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_SOURCE_DIR = path.resolve(__moduleDir, "../../skills");

async function buildSkillsDir(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-letta-skills-"));
  const entries = await fs.readdir(SKILLS_SOURCE_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await fs.symlink(
        path.join(SKILLS_SOURCE_DIR, entry.name),
        path.join(tmp, entry.name),
      );
    }
  }
  return tmp;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const lettaServerUrl = asString(config.lettaServerUrl, "");
  const lettaApiKey = asString(config.lettaApiKey, "");
  const agentName = asString(config.agentName, "");
  const model = asString(config.model, "");
  const cwd = asString(config.cwd, process.cwd());
  const timeoutSec = asNumber(config.timeoutSec, 600);
  const graceSec = asNumber(config.graceSec, 15);
  const maxTurns = asNumber(config.maxTurns, 0);
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const envConfig = parseObject(config.env);

  await ensureAbsoluteDirectory(cwd, { createIfMissing: false });

  // Build environment
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  if (lettaServerUrl) env.LETTA_BASE_URL = lettaServerUrl;
  if (lettaApiKey) env.LETTA_API_KEY = lettaApiKey;

  const taskId =
    (typeof context.taskId === "string" && context.taskId) ||
    (typeof context.issueId === "string" && context.issueId) ||
    null;
  const wakeReason = typeof context.wakeReason === "string" && context.wakeReason ? context.wakeReason : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId) ||
    (typeof context.commentId === "string" && context.commentId) ||
    null;
  const approvalId = typeof context.approvalId === "string" && context.approvalId ? context.approvalId : null;
  const approvalStatus = typeof context.approvalStatus === "string" && context.approvalStatus ? context.approvalStatus : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((v): v is string => typeof v === "string")
    : [];

  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (authToken) env.PAPERCLIP_API_KEY = authToken;

  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }

  const effectiveEnv = ensurePathInEnv({ ...process.env, ...env }) as Record<string, string>;

  // Resolve Letta agent ID
  const sessionParams = readSessionParams(runtime.sessionParams);
  let agentId: string;
  if (sessionParams?.agentId) {
    agentId = sessionParams.agentId;
  } else {
    const deps = makeLettaAgentDeps(lettaServerUrl, lettaApiKey || undefined, agentName, model);
    agentId = await resolveAgent(deps);
  }

  // Session resume
  const canResume =
    Boolean(sessionParams?.conversationId) &&
    Boolean(sessionParams?.cwd) &&
    path.resolve(sessionParams!.cwd) === path.resolve(cwd);
  const conversationId = canResume ? sessionParams!.conversationId : null;

  if (sessionParams?.conversationId && !canResume) {
    await onLog(
      "stdout",
      `[paperclip] Letta conversation "${sessionParams.conversationId}" was for cwd "${sessionParams.cwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  // Render prompt
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId },
    context,
  };
  const prompt = renderTemplate(promptTemplate, templateData).trim();

  // Inject skills
  let skillsDir: string | null = null;
  try {
    skillsDir = await buildSkillsDir();
  } catch {
    // Non-fatal: skills injection failed, continue without
    await onLog("stderr", "[paperclip] Warning: could not prepare skills directory.\n");
  }

  const buildArgs = (resumeConvId: string | null): string[] => {
    const args = ["-p", prompt, "--output-format", "stream-json", "--agent", agentId];
    if (resumeConvId) args.push("--conversation", resumeConvId);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    if (skillsDir) args.push("--skills", skillsDir);
    return args;
  };

  if (onMeta) {
    await onMeta({
      adapterType: "letta_code",
      command: "letta",
      cwd,
      commandArgs: buildArgs(conversationId),
      env: Object.fromEntries(
        Object.entries(env).map(([k, v]) =>
          /key|token|secret|password|authorization|cookie/i.test(k) ? [k, "[redacted]"] : [k, v],
        ),
      ),
      prompt,
      context,
    });
  }

  const runAttempt = async (resumeConvId: string | null) => {
    const args = buildArgs(resumeConvId);
    return runChildProcess(runId, "letta", args, {
      cwd,
      env: effectiveEnv,
      timeoutSec,
      graceSec,
      onLog,
      onSpawn,
    });
  };

  try {
    const proc = await runAttempt(conversationId);
    const parsed = parseLettaOutput(proc.stdout);

    // Retry on unknown conversation
    if (
      conversationId &&
      !proc.timedOut &&
      (proc.exitCode ?? 0) !== 0 &&
      isLettaUnknownConversationError(proc.stdout)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Letta conversation "${conversationId}" not found; retrying with a fresh conversation.\n`,
      );
      const retry = await runAttempt(null);
      const retryParsed = parseLettaOutput(retry.stdout);
      return toResult(retry, retryParsed, agentId, agentName, cwd, { clearSession: true });
    }

    return toResult(proc, parsed, agentId, agentName, cwd, { clearSession: false });
  } finally {
    if (skillsDir) {
      await fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function toResult(
  proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stderr: string },
  parsed: ReturnType<typeof parseLettaOutput>,
  agentId: string,
  agentName: string,
  cwd: string,
  opts: { clearSession: boolean },
): AdapterExecutionResult {
  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: "letta process timed out",
      clearSession: false,
    };
  }

  const failed = (proc.exitCode ?? 0) !== 0 || parsed.isError;
  const errorMessage = failed
    ? parsed.summary || proc.stderr.split(/\r?\n/).find(Boolean) || `letta exited with code ${proc.exitCode ?? -1}`
    : null;

  const newSessionParams =
    parsed.conversationId
      ? { conversationId: parsed.conversationId, agentId, agentName, cwd }
      : null;

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage,
    usage: parsed.usage ?? undefined,
    sessionParams: newSessionParams,
    sessionDisplayId: parsed.conversationId ?? null,
    model: parsed.model || null,
    provider: "letta",
    summary: parsed.summary || null,
    resultJson: parsed.resultJson ?? null,
    clearSession: opts.clearSession || (!parsed.conversationId && !opts.clearSession ? false : opts.clearSession),
  };
}
```

- [ ] **Step 4: Run smoke test**

```bash
bun test src/tests/execute.test.ts
```

Expected: `PASS`.

- [ ] **Step 5: Type-check**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/execute.ts src/tests/execute.test.ts
git commit -m "feat: add execute function — spawn letta CLI with session resume"
```

---

## Task 7: Root entry point (`src/index.ts`)

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Implement `src/index.ts`**

```typescript
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { execute } from "./server/execute.js";
import { testEnvironment } from "./server/test.js";
import { sessionCodec } from "./server/session.js";

export const type = "letta_code";
export const label = "Letta Code (local)";

export const models = [
  { id: "openai/gpt-4o", label: "GPT-4o" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
  { id: "anthropic/claude-opus-4-7-20251101", label: "Claude Opus 4.7" },
  { id: "anthropic/claude-sonnet-4-6-20251114", label: "Claude Sonnet 4.6" },
];

export const agentConfigurationDoc = `# letta_code agent configuration

Adapter: letta_code

Use when:
- You need a stateful Letta agent with persistent memory across task wakeups
- The agent should maintain conversation context between Paperclip heartbeats
- The task requires long-running work with Letta's tool-calling capabilities

Don't use when:
- You need a simple one-shot script (use the "process" adapter instead)
- No Letta server is available on the host
- You want a stateless agent without cross-run memory

Core fields:
- lettaServerUrl (string, required): URL of the Letta server, e.g. "http://localhost:8283"
- lettaApiKey (string, optional): API key for authenticated Letta server deployments
- agentName (string, required): Name of the Letta agent to use; created automatically if it doesn't exist
- model (string, optional): LLM model ID for agent creation only (e.g. "openai/gpt-4o"). Ignored if the agent already exists.
- cwd (string, required): Absolute path to the working directory for the letta process
- promptTemplate (string, optional): Paperclip wake prompt template. Defaults to the standard Paperclip agent prompt.
- maxTurns (number, optional): Maximum agent turns per run. 0 = unlimited.
- timeoutSec (number, optional, default 600): Hard process timeout in seconds.
- graceSec (number, optional, default 15): Grace period after SIGTERM before SIGKILL.
- env (object, optional): Additional environment variables injected into the letta process.
`;

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    models,
    agentConfigurationDoc,
    supportsLocalAgentJwt: true,
  };
}
```

- [ ] **Step 2: Write a quick smoke test**

```typescript
// src/tests/index.test.ts
import { describe, expect, test } from "bun:test";
import { createServerAdapter, type as adapterType } from "../index";

describe("createServerAdapter", () => {
  test("returns a module with required fields", () => {
    const mod = createServerAdapter();
    expect(mod.type).toBe("letta_code");
    expect(typeof mod.execute).toBe("function");
    expect(typeof mod.testEnvironment).toBe("function");
    expect(mod.sessionCodec).toBeDefined();
  });

  test("adapter type constant matches module type", () => {
    expect(adapterType).toBe("letta_code");
  });
});
```

- [ ] **Step 3: Run tests**

```bash
bun test src/tests/index.test.ts
```

Expected: all tests `PASS`.

- [ ] **Step 4: Run full type-check**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/tests/index.test.ts
git commit -m "feat: wire createServerAdapter entry point"
```

---

## Task 8: UI parser (`src/ui/parse-stdout.ts` + `src/ui/index.ts`)

**Files:**
- Create: `src/ui/parse-stdout.ts`
- Create: `src/ui/index.ts`
- Create: `src/tests/ui-parser.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/tests/ui-parser.test.ts
import { describe, expect, test } from "bun:test";
import { parseLettaStdoutLine } from "../ui/parse-stdout";

const TS = "2026-04-25T12:00:00.000Z";

describe("parseLettaStdoutLine", () => {
  test("system/init → init entry with model and conversationId as sessionId", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s1",
      uuid: "u1",
      agent_id: "a1",
      conversation_id: "conv-abc",
      model: "gpt-4o",
      tools: [],
      cwd: "/tmp",
      mcp_servers: [],
      permission_mode: "auto",
      slash_commands: [],
    });
    const entries = parseLettaStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("init");
    if (entries[0]?.kind === "init") {
      expect(entries[0].model).toBe("gpt-4o");
      expect(entries[0].sessionId).toBe("conv-abc");
    }
  });

  test("assistant message → assistant entry", () => {
    const line = JSON.stringify({
      type: "message",
      message_type: "assistant_message",
      session_id: "s1",
      uuid: "u2",
      agent_id: "a1",
      conversation_id: "conv-abc",
      text: "Hello, I will complete the task.",
    });
    const entries = parseLettaStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("assistant");
    if (entries[0]?.kind === "assistant") {
      expect(entries[0].text).toBe("Hello, I will complete the task.");
    }
  });

  test("reasoning message → thinking entry", () => {
    const line = JSON.stringify({
      type: "message",
      message_type: "reasoning_message",
      session_id: "s1",
      uuid: "u3",
      agent_id: "a1",
      conversation_id: "conv-abc",
      reasoning: "Let me think about this...",
    });
    const entries = parseLettaStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("thinking");
  });

  test("tool_call message → tool_call entry", () => {
    const line = JSON.stringify({
      type: "message",
      message_type: "tool_call",
      session_id: "s1",
      uuid: "u4",
      agent_id: "a1",
      conversation_id: "conv-abc",
      tool_call: { id: "tc1", name: "read_file", arguments: "{\"path\":\"/foo\"}" },
    });
    const entries = parseLettaStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("tool_call");
    if (entries[0]?.kind === "tool_call") {
      expect(entries[0].name).toBe("read_file");
    }
  });

  test("tool_return message → tool_result entry", () => {
    const line = JSON.stringify({
      type: "message",
      message_type: "tool_return",
      session_id: "s1",
      uuid: "u5",
      agent_id: "a1",
      conversation_id: "conv-abc",
      tool_return: "file contents here",
      status: "success",
      tool_call_id: "tc1",
    });
    const entries = parseLettaStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("tool_result");
    if (entries[0]?.kind === "tool_result") {
      expect(entries[0].isError).toBe(false);
    }
  });

  test("result event → result entry with usage", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "s1",
      uuid: "u6",
      agent_id: "a1",
      conversation_id: "conv-abc",
      duration_ms: 1000,
      duration_api_ms: 900,
      num_turns: 3,
      result: "Task done.",
      run_ids: [],
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    });
    const entries = parseLettaStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("result");
    if (entries[0]?.kind === "result") {
      expect(entries[0].inputTokens).toBe(100);
      expect(entries[0].outputTokens).toBe(40);
      expect(entries[0].isError).toBe(false);
    }
  });

  test("unparseable line → stdout fallback entry", () => {
    const entries = parseLettaStdoutLine("not json at all", TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("stdout");
  });

  test("empty line → empty array", () => {
    expect(parseLettaStdoutLine("", TS)).toHaveLength(0);
    expect(parseLettaStdoutLine("   ", TS)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test src/tests/ui-parser.test.ts
```

Expected: `FAIL` — `Cannot find module '../ui/parse-stdout'`

- [ ] **Step 3: Implement `src/ui/parse-stdout.ts`**

```typescript
import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function str(val: unknown, fallback = ""): string {
  return typeof val === "string" ? val : fallback;
}

function num(val: unknown, fallback = 0): number {
  return typeof val === "number" && Number.isFinite(val) ? val : fallback;
}

export function parseLettaStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const event = safeParseJson(trimmed);
  if (!event) {
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  const type = str(event.type);

  // system/init
  if (type === "system" && str(event.subtype) === "init") {
    return [
      {
        kind: "init",
        ts,
        model: str(event.model),
        sessionId: str(event.conversation_id),
      },
    ];
  }

  // content messages — all share type="message", discriminated by message_type
  if (type === "message") {
    const msgType = str(event.message_type);

    if (msgType === "assistant_message") {
      const text = str(event.text);
      if (!text) return [];
      return [{ kind: "assistant", ts, text }];
    }

    if (msgType === "reasoning_message") {
      const text = str(event.reasoning);
      if (!text) return [];
      return [{ kind: "thinking", ts, text }];
    }

    if (msgType === "tool_call" || msgType === "tool_calls") {
      const toolCall = event.tool_call as Record<string, unknown> | undefined;
      if (!toolCall) return [];
      let input: unknown = toolCall.arguments;
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { /* keep as string */ }
      }
      return [
        {
          kind: "tool_call",
          ts,
          name: str(toolCall.name),
          input,
          toolUseId: str(toolCall.id),
        },
      ];
    }

    if (msgType === "tool_return" || msgType === "tool_return_message") {
      const content = str(event.tool_return);
      const isError = str(event.status) === "error";
      return [
        {
          kind: "tool_result",
          ts,
          toolUseId: str(event.tool_call_id),
          content,
          isError,
        },
      ];
    }

    return [];
  }

  // result
  if (type === "result") {
    const usage = event.usage as Record<string, unknown> | null | undefined;
    const inputTokens = usage ? num(usage.prompt_tokens) : 0;
    const outputTokens = usage ? num(usage.completion_tokens) : 0;
    const cachedTokens = usage ? num(usage.cache_read_input_tokens) : 0;
    const isError = str(event.subtype) === "error";
    const text = str(event.result);
    return [
      {
        kind: "result",
        ts,
        text,
        inputTokens,
        outputTokens,
        cachedTokens,
        costUsd: 0,
        subtype: str(event.subtype, "success"),
        isError,
        errors: [],
      },
    ];
  }

  // error event
  if (type === "error") {
    return [{ kind: "stderr", ts, text: str(event.message) }];
  }

  // anything else: passthrough as stdout
  return [{ kind: "stdout", ts, text: trimmed }];
}
```

- [ ] **Step 4: Implement `src/ui/index.ts`**

```typescript
export { parseLettaStdoutLine } from "./parse-stdout.js";

export const adapterUiParser = {
  version: "1" as const,
  parseStdoutLine: (await import("./parse-stdout.js")).parseLettaStdoutLine,
};
```

Wait — static exports only; rewrite without top-level await:

```typescript
import { parseLettaStdoutLine } from "./parse-stdout.js";

export { parseLettaStdoutLine };

export const adapterUiParser = {
  version: "1" as const,
  parseStdoutLine: parseLettaStdoutLine,
};
```

- [ ] **Step 5: Run tests**

```bash
bun test src/tests/ui-parser.test.ts
```

Expected: all tests `PASS`.

- [ ] **Step 6: Run full test suite**

```bash
bun test src/tests
```

Expected: all test files `PASS`.

- [ ] **Step 7: Commit**

```bash
git add src/ui/parse-stdout.ts src/ui/index.ts src/tests/ui-parser.test.ts
git commit -m "feat: add UI stdout parser mapping letta stream-json to TranscriptEntry"
```

---

## Task 9: Paperclip skill (`src/skills/paperclip/SKILL.md`)

**Files:**
- Create: `src/skills/paperclip/SKILL.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: paperclip
description: Use this skill to interact with the Paperclip orchestration API. Invoke it when you need to create a sub-task or child issue, report a blocker, update issue status, or delegate work to another agent managed by Paperclip.
---

# Paperclip API Skill

This skill gives you access to the Paperclip task orchestration API. Use it to create issues, report status, and coordinate with other agents.

## Environment

The following environment variables are available in every Paperclip-managed run:

- `PAPERCLIP_API_URL` — Base URL of the Paperclip server
- `PAPERCLIP_API_KEY` — Bearer token for API authentication
- `PAPERCLIP_COMPANY_ID` — Your company ID (required in most API paths)
- `PAPERCLIP_TASK_ID` — The current task/issue ID you are working on

## Creating an Issue (sub-task or delegation)

```bash
curl -s -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Short, imperative title",
    "description": "Detailed description of what needs to be done and why.",
    "status": "todo",
    "priority": "medium",
    "parentId": "'"$PAPERCLIP_TASK_ID"'"
  }'
```

Fields:
- `title` (required) — Short imperative description
- `description` (required) — Full context for the assignee
- `status` (required) — One of: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `cancelled`
- `priority` (required) — One of: `urgent`, `high`, `medium`, `low`
- `parentId` (optional) — Set to `$PAPERCLIP_TASK_ID` to link as a child issue
- `assigneeAgentId` (optional) — Paperclip agent ID to assign to

## Reporting a Blocker

Create a child issue with a descriptive title and set `status` to `todo`. Assign it to the appropriate agent or leave unassigned for a human operator to pick up.

## When to Use

- You need to break work into parallel sub-tasks
- A dependency is not ready and another agent or human must act first
- You want to delegate a well-defined sub-problem to a specialized agent
- You are reporting that you are blocked and cannot proceed
```

- [ ] **Step 2: Commit**

```bash
git add src/skills/paperclip/SKILL.md
git commit -m "feat: add paperclip skill for issue creation and delegation"
```

---

## Task 10: Final validation and README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run full test suite and type-check**

```bash
bun test src/tests && bun run typecheck
```

Expected: all tests `PASS`, no type errors.

- [ ] **Step 2: Write `README.md`**

```markdown
# letta-code-paperclip-adapter

A [Paperclip](https://paperclip.ing) adapter that runs [Letta Code](https://github.com/letta-ai/letta-code) agents as Paperclip workers.

Paperclip spawns the `letta` CLI in headless mode, persists conversation threads across task wakeups, and injects a skill so agents can create Paperclip issues.

## Requirements

- `letta` CLI installed and on `PATH` (`npm install -g @letta-ai/letta-code`)
- A running Letta server (self-hosted or [Letta Cloud](https://letta.com))
- Paperclip server with external adapter support

## Installation

Install as a Paperclip adapter plugin (from the Paperclip board settings), or add to your Paperclip server's plugin directory:

```bash
npm install @letta-ai/letta-code-paperclip-adapter
```

## Adapter Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `lettaServerUrl` | yes | Letta server URL (e.g. `http://localhost:8283`) |
| `lettaApiKey` | no | API key for authenticated Letta deployments |
| `agentName` | yes | Name of the Letta agent — created automatically if absent |
| `model` | no | LLM model for agent creation (e.g. `openai/gpt-4o`) |
| `cwd` | yes | Absolute working directory for the `letta` process |
| `promptTemplate` | no | Paperclip wake prompt template |
| `maxTurns` | no | Max agent turns per run (0 = unlimited) |
| `timeoutSec` | no | Process timeout in seconds (default: 600) |
| `graceSec` | no | Grace period after SIGTERM (default: 15) |
| `env` | no | Extra environment variables for the `letta` process |

## Session Persistence

Each Paperclip task gets a persistent Letta conversation thread. When Paperclip wakes an agent again for the same task (approval callback, nudge, etc.), the adapter resumes the same thread so the agent retains full context of what it has already done.

## License

Apache-2.0
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Covered by task |
|---|---|
| Package structure + exports | Task 1 |
| `adapterConfig` fields | Tasks 1 (package.json), 6 (execute), 7 (index/agentConfigurationDoc) |
| Agent lookup/create | Task 4 |
| CLI invocation (`-p`, `--output-format stream-json`, `--agent`, `--conversation`, `--skills`) | Task 6 |
| Env var injection (PAPERCLIP_*, LETTA_BASE_URL, LETTA_API_KEY) | Task 6 |
| Skills injection (tmpdir + symlink + `--skills`) | Task 6 |
| Session management (serialize/deserialize/getDisplayId) | Task 3 |
| Output parsing | Task 2 |
| `isLettaUnknownConversationError` + retry | Tasks 2, 6 |
| `testEnvironment` | Task 5 |
| UI parser (`TranscriptEntry` mapping) | Task 8 |
| `./ui-parser` export | Task 8 |
| Paperclip skill SKILL.md | Task 9 |
| Error handling (timeout, unknown conv, non-zero exit) | Tasks 2, 6 |

No gaps found.

**Type consistency check:** `parseLettaOutput` defined in Task 2, used in Task 6. `readSessionParams` defined in Task 3, used in Task 6. `resolveAgent` / `makeLettaAgentDeps` defined in Task 4, used in Task 6. `testEnvironment` defined in Task 5, used in Task 7. `sessionCodec` defined in Task 3, used in Task 7. All consistent.
