# Task Tool: Model Validation & Discovery

**Date:** 2026-04-26
**Status:** Approved

## Problem

The Task tool accepts an optional `model` parameter but does not validate it before spawning a subagent. If the model doesn't exist on the connected server, the failure surfaces as a cryptic downstream error from the subagent CLI process. Additionally, there is no way for a calling agent to discover valid model handles before attempting to spawn — forcing trial-and-error.

A secondary issue: `letta/auto-memory` (used by the reflection subagent type) does not exist on OSS/self-hosted servers, causing silent failures in those environments.

## Goals

1. Fail early with an actionable error when a user-provided model isn't available on the server.
2. Make all internally resolved models resilient — fall back gracefully when a resolved handle isn't available.
3. Default subagent model to the calling agent's model when none is specified.
4. Provide a `list-models` sub-command for proactive model discovery with fuzzy search.

## Design

### 1. Default Model Inheritance

**File:** `src/agent/subagents/manager.ts` — `resolveSubagentModel()`

When no `userModel` is provided, `parentModelHandle` becomes the default. It is moved up in priority above the subagent-type recommended model. Free-tier overrides remain above it.

**Priority order (after change):**
```
userModel (validated)
  → reflection pin (letta/auto-memory)
  → free-tier overrides (auto-fast, tier default)
  → parentModelHandle          ← promoted
  → recommendedModel
  → hardcoded default
```

### 2. Universal Availability Check

**File:** `src/agent/subagents/manager.ts` — `resolveSubagentModel()`

After resolving a model through any path, validate it against `getAvailableModelHandles()`. Failure behavior differs by resolution path:

**User-provided model (`userModel`):**
- Check handle against `getAvailableModelHandles()`
- If invalid: return a structured error result (do NOT fall back silently)
- Error includes a filtered list of valid handles from the inferred provider:
  - Infer provider from the prefix of the user-typed handle (e.g., `anthropic/claude-5-fake` → `anthropic`)
  - If no prefix present, fall back to the parent agent's model provider
- Error format: `"Model 'X' is not available. Valid anthropic models: [anthropic/claude-sonnet-4-6, ...]"`
- The calling agent reads the list and retries with a correct handle.

**Internally resolved models (reflection, recommended, defaults):**
- Check handle against `getAvailableModelHandles()`
- If unavailable: silently fall back to `parentModelHandle`
- If `parentModelHandle` is also unavailable or null: continue down the existing default chain
- No error is surfaced for internal resolution failures

### 3. `list-models` Sub-command

**File:** `src/tools/impl/Task.ts`

Add `command: "list-models"` to the Task tool. No subagent is spawned. The command calls `getAvailableModelHandles()` directly and returns the filtered handle list.

**Parameter:** `query` — optional string. Case-insensitive substring match against the full model handle.

```
Task({ command: "list-models" })                     // all models
Task({ command: "list-models", query: "kimi" })      // matches moonshot/kimi-k2, etc.
Task({ command: "list-models", query: "anthropic" }) // all anthropic/* handles
```

Returns: `{ models: string[] }` sorted alphabetically.

### 4. Schema & Description Updates

**File:** `src/tools/schemas/Task.json`

- Add `"list-models"` to the `command` enum
- Add optional `query` string param (only meaningful with `list-models`)
- Update `model` field description:
  > "Model handle for the subagent. Omit to inherit the calling agent's model. Use `command: list-models` to discover valid handles before spawning."

## Key Files

| File | Change |
|------|--------|
| `src/agent/subagents/manager.ts` | `resolveSubagentModel()` — add validation, reorder priority, add availability fallback |
| `src/tools/impl/Task.ts` | Add `list-models` command handler |
| `src/tools/schemas/Task.json` | Add `list-models` to enum, add `query` param, update `model` description |
| `src/agent/available-models.ts` | No changes — `getAvailableModelHandles()` used as-is |

## Out of Scope

- Changes to the free-tier override logic (auto-fast, tier default).
- Changes to how BYOK provider prefix swapping works.
- Any UI changes.
