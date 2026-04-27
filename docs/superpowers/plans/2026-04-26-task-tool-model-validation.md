# Task Tool Model Validation & Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate user-provided models early, fall back gracefully for internally resolved models, default to parent model inheritance, and add a `list-models` command for discovery.

**Architecture:** Changes are split across two files — `src/agent/subagents/manager.ts` for internal resolution logic and `src/tools/impl/Task.ts` for user-facing validation and the `list-models` command. A small exported helper (`formatInvalidModelError`) in `Task.ts` isolates validation logic for direct unit testing. Schema changes are in `src/tools/schemas/Task.json`.

**Tech Stack:** TypeScript, Bun test, existing `getAvailableModelHandles()` from `src/agent/available-models.ts`.

---

## File Map

| File | What changes |
|------|-------------|
| `src/agent/subagents/manager.ts` | Export `getProviderPrefix`; add reflection availability fallback; promote `parentModelHandle` above `recommendedModel` for non-BYOK parents |
| `src/tools/impl/Task.ts` | Add `formatInvalidModelError` helper; add model validation before `spawnSubagent`; add `list-models` command |
| `src/tools/schemas/Task.json` | Add `command` and `query` fields; update `model` description; adjust `required` |
| `src/tests/agent/subagent-model-resolution.test.ts` | New tests for reflection fallback and parent model promotion; update one stale test |
| `src/tests/tools/task-model-validation.test.ts` | New file — unit tests for `formatInvalidModelError` and `list-models` output shape |

---

## Task 1: Export `getProviderPrefix` from manager.ts

**Files:**
- Modify: `src/agent/subagents/manager.ts:143`

- [ ] **Step 1: Add `export` to `getProviderPrefix`**

In `src/agent/subagents/manager.ts`, change line 143:
```typescript
// before
function getProviderPrefix(handle: string): string | null {

// after
export function getProviderPrefix(handle: string): string | null {
```

- [ ] **Step 2: Verify it compiles**

```bash
bun tsc --noEmit 2>&1 | head -20
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/subagents/manager.ts
git commit -m "refactor(subagents): export getProviderPrefix"
```

---

## Task 2: Add reflection availability fallback in `resolveSubagentModel()`

**Context:** Currently the reflection subagent is hardcoded to `letta/auto-memory` with no availability check. On OSS servers this model doesn't exist, causing a downstream failure. Fix: check availability and fall through to `parentModelHandle` if not found.

**Files:**
- Modify: `src/agent/subagents/manager.ts:166-263`
- Modify: `src/tests/agent/subagent-model-resolution.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/tests/agent/subagent-model-resolution.test.ts` inside `describe("resolveSubagentModel")`:

```typescript
test("reflection falls back to parentModelHandle when letta/auto-memory is unavailable", async () => {
  const result = await resolveSubagentModel({
    subagentType: "reflection",
    parentModelHandle: "anthropic/claude-sonnet-4-6",
    availableHandles: new Set(["anthropic/claude-sonnet-4-6"]), // no letta/auto-memory
  });

  expect(result).toBe("anthropic/claude-sonnet-4-6");
});

test("reflection falls back to null when letta/auto-memory and parentModelHandle are both unavailable", async () => {
  const result = await resolveSubagentModel({
    subagentType: "reflection",
    availableHandles: new Set(["anthropic/claude-sonnet-4-6"]), // no letta/auto-memory, no parent
  });

  expect(result).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/tests/agent/subagent-model-resolution.test.ts 2>&1 | tail -20
```
Expected: the two new tests fail (reflection currently returns `letta/auto-memory` regardless).

- [ ] **Step 3: Move `isAvailable` helper before the reflection check and add fallback**

In `src/agent/subagents/manager.ts`, replace the body of `resolveSubagentModel` from line 174 to line 200 with:

```typescript
  const { userModel, recommendedModel, parentModelHandle, billingTier } =
    options;
  const isFreeTier = billingTier?.toLowerCase() === "free";

  if (userModel) return userModel;

  // Build isAvailable helper early so it can be used by the reflection check.
  let availableHandles: Set<string> | null = options.availableHandles ?? null;
  const isAvailable = async (handle: string): Promise<boolean> => {
    try {
      if (!availableHandles) {
        const result = await getAvailableModelHandles();
        availableHandles = result.handles;
      }
      return availableHandles.has(handle);
    } catch {
      return false;
    }
  };

  if (options.subagentType === "reflection") {
    if (await isAvailable("letta/auto-memory")) {
      return "letta/auto-memory";
    }
    // letta/auto-memory not on this server — fall through to parentModelHandle below
  }
```

Then find and delete the now-duplicate block that looks like this (it appears just below `recommendedHandle` declaration, after the `if (subagentType === "reflection")` block):

```typescript
// DELETE this block — it is now a duplicate:
let availableHandles: Set<string> | null = options.availableHandles ?? null;
const isAvailable = async (handle: string): Promise<boolean> => {
  try {
    if (!availableHandles) {
      const result = await getAvailableModelHandles();
      availableHandles = result.handles;
    }
    return availableHandles.has(handle);
  } catch {
    return false;
  }
};
```

The rest of the function body (free-tier checks, parentModelHandle block, etc.) stays unchanged.

- [ ] **Step 4: Run tests**

```bash
bun test src/tests/agent/subagent-model-resolution.test.ts 2>&1 | tail -20
```
Expected: all tests pass, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src/agent/subagents/manager.ts src/tests/agent/subagent-model-resolution.test.ts
git commit -m "fix(subagents): fall back to parent model when letta/auto-memory is unavailable"
```

---

## Task 3: Promote `parentModelHandle` above `recommendedModel` for non-BYOK parents

**Context:** Currently, when a non-BYOK parent model is set and a `recommendedModel` is available, the recommended model wins. After this change, the parent's model takes precedence. BYOK logic is unchanged.

**Files:**
- Modify: `src/agent/subagents/manager.ts:216-250`
- Modify: `src/tests/agent/subagent-model-resolution.test.ts`

- [ ] **Step 1: Update the stale test to reflect new expected behavior**

In `src/tests/agent/subagent-model-resolution.test.ts`, change the test `"uses recommended model when parent is not BYOK and model is available"`:

```typescript
// before
test("uses recommended model when parent is not BYOK and model is available", async () => {
  const result = await resolveSubagentModel({
    recommendedModel: "anthropic/test-model",
    parentModelHandle: "anthropic/parent-model",
    availableHandles: new Set(["anthropic/test-model"]),
  });

  expect(result).toBe("anthropic/test-model");
});

// after
test("inherits parent model when parent is not BYOK, regardless of recommended model", async () => {
  const result = await resolveSubagentModel({
    recommendedModel: "anthropic/test-model",
    parentModelHandle: "anthropic/parent-model",
    availableHandles: new Set(["anthropic/test-model", "anthropic/parent-model"]),
  });

  expect(result).toBe("anthropic/parent-model");
});
```

- [ ] **Step 2: Run tests to verify the renamed test now fails (expected)**

```bash
bun test src/tests/agent/subagent-model-resolution.test.ts 2>&1 | tail -20
```
Expected: the renamed test fails because the code still returns `recommendedModel` first.

- [ ] **Step 3: Change the non-BYOK path to return `parentModelHandle` directly**

In `src/agent/subagents/manager.ts`, find the block inside `if (parentModelHandle)` (around line 216). Replace the non-BYOK path:

```typescript
  if (parentModelHandle) {
    const parentProvider = getProviderPrefix(parentModelHandle);
    const parentBaseProvider = parentProvider
      ? BYOK_PROVIDER_TO_BASE[parentProvider]
      : null;
    const parentIsByok = !!parentBaseProvider;

    if (recommendedHandle) {
      const recommendedProvider = getProviderPrefix(recommendedHandle);

      if (parentIsByok) {
        if (recommendedProvider === parentProvider) {
          if (await isAvailable(recommendedHandle)) {
            return recommendedHandle;
          }
        } else {
          const swapped = swapProviderPrefix(
            parentModelHandle,
            recommendedHandle,
          );
          if (swapped && (await isAvailable(swapped))) {
            return swapped;
          }
        }

        return parentModelHandle;
      }

      // Non-BYOK: parent model takes precedence (recommended is a hint, not override)
    }

    return parentModelHandle;
  }
```

The key change: the non-BYOK `if (await isAvailable(recommendedHandle)) { return recommendedHandle; }` block is removed. The function falls through directly to `return parentModelHandle`.

- [ ] **Step 4: Run all model resolution tests**

```bash
bun test src/tests/agent/subagent-model-resolution.test.ts 2>&1 | tail -30
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/subagents/manager.ts src/tests/agent/subagent-model-resolution.test.ts
git commit -m "feat(subagents): inherit parent model by default instead of subagent recommended model"
```

---

## Task 4: Add `formatInvalidModelError` helper and user model validation in Task.ts

**Context:** When the user passes a model that doesn't exist on the server, we want to fail early with a helpful error listing valid models from the same provider. The helper is extracted so it can be unit-tested without mocking the module system.

**Files:**
- Modify: `src/tools/impl/Task.ts`
- Create: `src/tests/tools/task-model-validation.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/tests/tools/task-model-validation.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { formatInvalidModelError } from "../../tools/impl/Task";

describe("formatInvalidModelError", () => {
  test("lists available models from the same provider prefix", () => {
    const handles = new Set([
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5",
      "openai/gpt-4o",
    ]);

    const error = formatInvalidModelError("anthropic/claude-5-fake", handles);

    expect(error).toContain("anthropic/claude-5-fake");
    expect(error).toContain("anthropic/claude-sonnet-4-6");
    expect(error).toContain("anthropic/claude-haiku-4-5");
    expect(error).not.toContain("openai/gpt-4o");
  });

  test("shows all models when the user-typed handle has no provider prefix", () => {
    const handles = new Set([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4o",
    ]);

    const error = formatInvalidModelError("claude-5-fake", handles);

    expect(error).toContain("anthropic/claude-sonnet-4-6");
    expect(error).toContain("openai/gpt-4o");
  });

  test("suggests list-models when no matching provider models exist", () => {
    const handles = new Set(["openai/gpt-4o"]);

    const error = formatInvalidModelError("anthropic/claude-5-fake", handles);

    expect(error).toContain("list-models");
  });

  test("returns sorted model list", () => {
    const handles = new Set([
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-7",
    ]);

    const error = formatInvalidModelError("anthropic/bad-model", handles);
    const modelsSection = error.slice(error.indexOf("anthropic/claude"));

    expect(modelsSection.indexOf("claude-haiku")).toBeLessThan(
      modelsSection.indexOf("claude-opus"),
    );
    expect(modelsSection.indexOf("claude-opus")).toBeLessThan(
      modelsSection.indexOf("claude-sonnet"),
    );
  });
});
```

- [ ] **Step 2: Run to verify tests fail**

```bash
bun test src/tests/tools/task-model-validation.test.ts 2>&1 | tail -20
```
Expected: fails with "formatInvalidModelError is not exported".

- [ ] **Step 3: Add the helper and import to Task.ts**

At the top of `src/tools/impl/Task.ts`, add the import:
```typescript
import { getAvailableModelHandles } from "../../agent/available-models";
import { getProviderPrefix } from "../../agent/subagents/manager";
```

After the `BACKGROUND_STARTUP_POLL_MS` constant (around line 57), add:

```typescript
/**
 * Formats a human-readable error for an unrecognised model handle.
 * Exported for direct unit testing without module mocking.
 */
export function formatInvalidModelError(
  model: string,
  handles: Set<string>,
): string {
  const prefix = getProviderPrefix(model);
  const filtered = [...handles]
    .filter((h) => !prefix || h.startsWith(`${prefix}/`))
    .sort();

  if (filtered.length === 0) {
    return `Model '${model}' is not available on this server. Use \`command: list-models\` to see all available models.`;
  }

  const label = prefix ?? "available";
  return `Model '${model}' is not available on this server. Valid ${label} models: ${filtered.join(", ")}`;
}
```

- [ ] **Step 4: Run unit tests to verify they pass**

```bash
bun test src/tests/tools/task-model-validation.test.ts 2>&1 | tail -20
```
Expected: all pass.

- [ ] **Step 5: Add model validation inside the `task()` function**

In `src/tools/impl/Task.ts`, in the `task()` function, after:
```typescript
const { command = "run", model, toolCallId, signal } = args;
```

Add:
```typescript
  // Validate user-provided model early to avoid cryptic downstream errors.
  if (model && command === "run") {
    try {
      const { handles } = await getAvailableModelHandles();
      if (!handles.has(model)) {
        return formatInvalidModelError(model, handles);
      }
    } catch {
      // Can't reach the server to validate — let it proceed and fail downstream.
    }
  }
```

- [ ] **Step 6: Verify full test suite still passes**

```bash
bun test src/tests/tools/ 2>&1 | tail -30
```
Expected: all existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/tools/impl/Task.ts src/tests/tools/task-model-validation.test.ts
git commit -m "feat(task): validate model handle early and return actionable error with provider model list"
```

---

## Task 5: Add `list-models` command to Task.ts

**Files:**
- Modify: `src/tools/impl/Task.ts`
- Modify: `src/tests/tools/task-model-validation.test.ts`

- [ ] **Step 1: Write failing test**

Add to `src/tests/tools/task-model-validation.test.ts`. First update the import at the top of the file to include `filterModelHandles`:

```typescript
import { formatInvalidModelError, filterModelHandles } from "../../tools/impl/Task";
```

Then add the new describe block:

```typescript
import { describe, expect, test } from "bun:test";
import { formatInvalidModelError, filterModelHandles } from "../../tools/impl/Task";

describe("filterModelHandles", () => {
  const handles = new Set([
    "moonshot/kimi-k2",
    "moonshot/kimi-latest",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-haiku-4-5",
    "openai/gpt-4o",
  ]);

  test("returns all models sorted when no query", () => {
    const result = filterModelHandles(handles, undefined);
    expect(result).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-4-6",
      "moonshot/kimi-k2",
      "moonshot/kimi-latest",
      "openai/gpt-4o",
    ]);
  });

  test("filters by case-insensitive substring match", () => {
    const result = filterModelHandles(handles, "kimi");
    expect(result).toEqual(["moonshot/kimi-k2", "moonshot/kimi-latest"]);
  });

  test("matches across provider and model name", () => {
    const result = filterModelHandles(handles, "claude");
    expect(result).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  test("returns empty array when nothing matches", () => {
    const result = filterModelHandles(handles, "llama");
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify tests fail**

```bash
bun test src/tests/tools/task-model-validation.test.ts 2>&1 | tail -20
```
Expected: fails with "filterModelHandles is not exported".

- [ ] **Step 3: Add `filterModelHandles` export to Task.ts**

After `formatInvalidModelError`, add:

```typescript
export function filterModelHandles(
  handles: Set<string>,
  query: string | undefined,
): string[] {
  const q = query?.toLowerCase();
  return [...handles]
    .filter((h) => !q || h.toLowerCase().includes(q))
    .sort();
}
```

- [ ] **Step 4: Update `TaskArgs` interface to include the new command and param**

In `src/tools/impl/Task.ts`, update the interface:

```typescript
interface TaskArgs {
  command?: "run" | "refresh" | "list-models";
  query?: string;           // used with list-models
  subagent_type?: string;
  // ... rest unchanged
}
```

- [ ] **Step 5: Add the `list-models` handler block in `task()`**

After the `refresh` handler block (around line 603), add:

```typescript
  if (command === "list-models") {
    const { handles } = await getAvailableModelHandles();
    const models = filterModelHandles(handles, args.query);
    return JSON.stringify({ models });
  }
```

- [ ] **Step 6: Run all tests**

```bash
bun test src/tests/tools/task-model-validation.test.ts 2>&1 | tail -20
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/tools/impl/Task.ts src/tests/tools/task-model-validation.test.ts
git commit -m "feat(task): add list-models command with fuzzy search"
```

---

## Task 6: Update Task.json schema

**Files:**
- Modify: `src/tools/schemas/Task.json`

- [ ] **Step 1: Update the schema**

Replace the contents of `src/tools/schemas/Task.json` with:

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "enum": ["run", "refresh", "list-models"],
      "description": "Command to run. 'run' (default) spawns a subagent. 'refresh' re-discovers custom subagents from .letta/agents/. 'list-models' returns available model handles without spawning anything."
    },
    "query": {
      "type": "string",
      "description": "Fuzzy search query for list-models. Case-insensitive substring match against the full model handle (e.g. 'kimi', 'claude-sonnet', 'anthropic'). Only used with command: list-models."
    },
    "description": {
      "type": "string",
      "description": "A short (3-5 word) description of the task"
    },
    "prompt": {
      "type": "string",
      "description": "The task for the agent to perform"
    },
    "subagent_type": {
      "type": "string",
      "description": "The type of specialized agent to use for this task"
    },
    "model": {
      "type": "string",
      "description": "Model handle for the subagent. Omit to inherit the calling agent's model. Use `command: list-models` to discover valid handles before spawning."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Set to true to run this agent in the background. The tool result will include an output_file path - use Read tool or Bash tail to check on output."
    },
    "agent_id": {
      "type": "string",
      "description": "Deploy an existing agent instead of creating a new one. Starts a new conversation with that agent."
    },
    "conversation_id": {
      "type": "string",
      "description": "Resume from an existing conversation. Does NOT require agent_id (conversation IDs are unique and encode the agent)."
    }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Note: `required` is emptied here because `description`, `prompt`, and `subagent_type` are only required for the `run` command — the existing runtime validation in `task()` already enforces this via `validateRequiredParams`. The LLM description text guides correct usage.

- [ ] **Step 2: Verify TypeScript still compiles**

```bash
bun tsc --noEmit 2>&1 | head -20
```
Expected: no errors.

- [ ] **Step 3: Run full test suite**

```bash
bun test src/tests/ 2>&1 | tail -30
```
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/tools/schemas/Task.json
git commit -m "feat(task): add command and query fields to schema; update model description"
```

---

## Done

All four spec goals are met:
1. User-provided models are validated early with a provider-filtered error list
2. Internally resolved models (reflection) fall back gracefully when unavailable
3. Subagents inherit the parent's model by default
4. `list-models` command provides proactive discovery with fuzzy search
