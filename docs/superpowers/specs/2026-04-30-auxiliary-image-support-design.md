# Auxiliary Image Support — Design

**Date:** 2026-04-30
**Target codebase:** letta server (`Projects/letta`)
**Branch off:** `snowctl/main`

## Problem

Some LLM providers either don't support vision at all or have provider-side bugs that silently break vision when certain conditions are met. The concrete trigger for this work is **kimi-k2.6 hosted on crof.ai**: a 200-OK-empty-stream response when a request contains both `role: "system"` and an `image_url` content part. Same image with no system role works; same payload to a different model (qwen3.6-27b) on the same endpoint also works. crof.ai has acknowledged the bug and is investigating.

Today letta server's only graceful-degradation path on this kind of failure is to *strip images and retry text-only* — meaning the agent loses vision entirely. We want a better fallback: route the image to a separate, vision-capable auxiliary model, get a textual description, inline that description into the request, and let the main agent flow continue. The main model never sees the raw image; it sees an auto-generated description.

## Goal

Add an "auxiliary vision" path to letta server that:

1. **Pre-call mode:** can be enabled per-agent via `llm_config.capability_overrides["vision"] = "unsupported"` so every image bound for that LLM is replaced with an aux-generated description before the request is sent.
2. **Reactive mode:** automatically catches vision-related failures from any LLM (vision-marker 400 or empty-stream-after-image) and retries with images replaced by aux descriptions, instead of stripping them.
3. **Caches descriptions** by image content hash so re-sending the same image to the same aux model on later turns doesn't re-pay the API cost.
4. **Stays transient:** the agent's stored conversation history keeps the original image bytes intact. Descriptions are generated at LLM-call time only; if the main provider's vision support gets fixed later, past images "just work" again with no migration.

Out of scope for this design (deferred to a possible future iteration):

- Resolution chains across multiple aux providers (main → OpenRouter → Nous Portal → custom)
- Credit-pool / 402-retry semantics
- Per-task auxiliary tasks beyond vision (compression, search, web extraction)
- Per-agent aux override (env-var-only configuration is enough)
- Async-and-sync parallel client variants — only the variant each call site needs

The module is *named* and *shaped* so adding any of the above later is extension, not rewrite.

## Architecture

```
letta-code (unchanged)
   │
   │  multimodal tool_return  (image_url + text)
   ▼
letta server: store in postgres tool_returns.func_response
   │
   ▼  (LLM call time)
to_openai_dicts_from_list(messages, image_describer=…)
   │
   ├── llm_config.capability_overrides["vision"] == "unsupported"?
   │     yes → call image_describer for each image_url part
   │           → replace image_url with text description
   │     no  → pass image_url through unchanged
   │
   ▼
openai_client.{request,request_async,stream_async}
   │
   ├── HTTP 400 with vision marker  ─┐
   ├── empty-stream after image     ─┤── repurpose existing retry hook:
   │                                  │   route images through aux,
   │                                  │   retry with descriptions inlined.
   │                                  │   strip-images stays as final
   │                                  │   fallback when aux unconfigured
   │                                  │   or aux call fails.
   ▼                                  ▼
response → agent
```

letta-code, Argos, and the SDK contract are untouched. Only letta server changes.

## Components

### 1. `letta/llm_api/auxiliary_client.py` (new module, ~150 LOC)

Self-contained module exposing image-description helpers and an in-process LRU cache.

```python
class AuxTask(str, Enum):
    VISION = "vision"
    # COMPRESSION = "compression"   # future
    # WEB_EXTRACT = "web_extract"   # future


@dataclass(frozen=True)
class AuxConfig:
    base_url: str
    model: str
    api_key: str


def _resolve_aux_config(task: AuxTask) -> Optional[AuxConfig]:
    """Read LETTA_AUX_<TASK>_BASE_URL / _MODEL / _API_KEY.

    Returns None when any of the three is missing — callers must treat
    that as "auxiliary not configured" and fall back accordingly.
    """


def describe_image(data_url: str, *, prompt: Optional[str] = None) -> str:
    """Sync. Returns a 1–3 sentence description, or raises AuxUnavailable
    if config is missing or the aux call fails."""


async def describe_image_async(data_url: str, *, prompt: Optional[str] = None) -> str:
    """Async mirror, used by streaming/async LLM call paths."""
```

**Cache:** module-level `OrderedDict` keyed by `(task: str, content_hash: str, aux_model: str)`, capped at 256 entries with LRU eviction. `content_hash = sha256(image_bytes)` extracted from the `data:…;base64,…` URL. Cache hits skip the aux call entirely. Thread-safe via a single `threading.Lock`.

**Default prompt:** `"Describe this image. Be concise but capture text content (OCR if visible) and notable visual elements."` — chosen because the most common tool-return image source (Read of a screenshot, terminal-state image, error dialog) tends to need OCR over prose. Overridable per call via the `prompt` kwarg, and globally via the `LETTA_AUX_VISION_PROMPT` env var.

**Errors:** raises a new `AuxUnavailable` exception in `letta/errors.py` for the missing-config and aux-call-failed cases. Callers decide whether to fall back to placeholder text or strip the image.

### 2. `letta/schemas/llm_config.py`

Add a single field:

```python
capability_overrides: Dict[str, str] = Field(
    default_factory=dict,
    description=(
        "Optional per-agent capability overrides. Keys are capability "
        "names (e.g. 'vision'); values are 'supported', 'unsupported', "
        "or 'auto' (default if absent). Used to force-disable a "
        "capability on a specific provider (e.g. kimi-k2.6 on crof.ai "
        "vision)."
    ),
)
```

Plus a small helper:

```python
def vision_capability(self) -> Literal["supported", "unsupported", "auto"]:
    return self.capability_overrides.get("vision", "auto")  # type: ignore[return-value]
```

The `Dict[str, str]` shape is forward-compatible with future capabilities (`compression`, `web_extract`, etc.) without a schema migration.

### 3. `letta/schemas/message.py` — `to_openai_dicts_from_list`

Add an optional kwarg threaded through the existing call-sites:

```python
def to_openai_dicts_from_list(
    messages: List[Message],
    *,
    max_tool_id_length: Optional[int] = None,
    put_inner_thoughts_in_kwargs: bool = False,
    tool_return_truncation_chars: Optional[int] = None,
    image_describer: Optional[Callable[[str], str]] = None,  # NEW
) -> List[dict]:
```

When `image_describer` is provided, the existing image-extraction logic (currently producing the synthetic image-only user message) instead inlines `{"type": "text", "text": f"[Image (auto-described): {description}]"}` in place of each `image_url` part. The synthetic user message is not generated at all in this mode — the description text becomes part of the corresponding tool message's body.

When `image_describer` is `None`, behavior is byte-identical to today.

Type alias:

```python
ImageDescriber = Callable[[str], str]  # data_url -> description
```

`image_describer` is **sync only**. `to_openai_dicts_from_list` itself is sync, called during message-list construction *before* the async LLM HTTP call begins. The aux HTTP call blocks the calling thread for one roundtrip per uncached image — bounded and acceptable. The async openai-client reactive retry path does not go through `to_openai_dicts_from_list` (it operates on already-serialized dicts) and uses `describe_image_async` directly; see Component 4.

Concretely, the serializer's existing tool-message branch changes from:

```python
if image_urls:
    text = f"{body_text} [Image attached in next message]"
    pending_image_urls.extend(image_urls)   # buffer for synthetic user msg
else:
    text = body_text
```

to:

```python
if image_urls:
    if image_describer is not None:
        descriptions = [_safely_describe(image_describer, u) for u in image_urls]
        joined = "\n\n".join(f"[Image (auto-described): {d}]" for d in descriptions)
        text = f"{body_text}\n\n{joined}".strip() if body_text else joined
        # NOTE: do NOT add to pending_image_urls — no synthetic user msg.
    else:
        text = f"{body_text} [Image attached in next message]"
        pending_image_urls.extend(image_urls)
else:
    text = body_text
```

`_safely_describe` is a tiny inline helper that catches `AuxUnavailable` and substitutes `"[Image (auto-description failed)]"` so a single aux failure can't poison the whole serialization.

### 4. `letta/llm_api/openai_client.py` — repurpose retry hooks

The reactive hooks added in commits `936b4057` (sync), `906adf1e` (async), `612b8534` (stream), and `239561ae` (empty-stream retry) currently call `_strip_tool_return_image_messages` to remove image content on retry. This work changes the *retry factory* of those hooks to call aux-description rewrites instead, with strip-images preserved as the final fallback.

Two rewrite helpers — sync and async, sharing the same logic and matching pre-call output:

```python
def _replace_images_with_descriptions(messages: List[dict]) -> List[dict]:
    """Sync. Used by `OpenAIClient.request` retry path.
    For each synthetic image-only user message in `messages`:
      - extract image_url data URLs
      - call `auxiliary_client.describe_image` for each (cache-aware)
      - drop the synthetic user message
      - append the descriptions to the preceding tool message's text
    Result: bytes-equivalent to what pre-call mode would have produced.
    On AuxUnavailable: returns `_strip_tool_return_image_messages(messages)`
    instead — graceful fallback. Logs warnings but never raises."""

async def _replace_images_with_descriptions_async(messages: List[dict]) -> List[dict]:
    """Async. Used by `OpenAIClient.request_async` and `stream_async`.
    Same semantics; calls `auxiliary_client.describe_image_async`."""
```

Pre-call (serializer-level) and reactive (openai_client-level) produce **structurally identical output**: tool message body containing the description text, no synthetic image-only user message. This means a request that already went through pre-call is idempotent under reactive retry — no images to find, retry no-ops at the rewrite step.

The existing `_strip_tool_return_image_messages` stays as the final fallback. The `_EmptyImageResponseRetryStream` wrapper keeps its TTFT-preserving buffer logic; only its retry factory is swapped.

### 5. Caller wiring — `letta/agents/letta_agent.py`

Every call site that invokes `to_openai_dicts_from_list` for the OpenAI Chat Completions path passes the same sync `image_describer`:

```python
image_describer = (
    auxiliary_client.describe_image
    if agent_state.llm_config.vision_capability() == "unsupported"
    else None
)
openai_dicts = Message.to_openai_dicts_from_list(
    messages,
    image_describer=image_describer,
    ...
)
```

Whether the LLM call that follows is sync, async, or streaming is irrelevant to the serializer — the aux roundtrip happens during sync message-list construction, before the LLM call begins.

## Configuration

Environment variables consumed by `_resolve_aux_config`, with fallbacks to vanilla OpenAI-SDK env vars so aux can piggyback on the same provider when convenient:

| Variable | Fallback | Example | Required |
|---|---|---|---|
| `LETTA_AUX_VISION_BASE_URL` | `OPENAI_BASE_URL` | `https://crof.ai/v1` | yes (one of them) |
| `LETTA_AUX_VISION_API_KEY` | `OPENAI_API_KEY` | `nahcrof_…` | yes (one of them) |
| `LETTA_AUX_VISION_MODEL` | *(none — must be explicit)* | `qwen3.6-27b` | yes |
| `LETTA_AUX_VISION_PROMPT` | *(uses module default)* | `"Describe…"` | no |

`_resolve_aux_config` reads the LETTA-specific var first, then the OPENAI-prefixed fallback. `MODEL` has no fallback because aggregator endpoints serve many models — picking one implicitly would be too magical.

When `BASE_URL` or `API_KEY` cannot be resolved, or `MODEL` is unset: `_resolve_aux_config` returns `None`, log a single warning per process (`logger.warning("auxiliary_client: LETTA_AUX_VISION_* not configured (missing %s); vision auxiliary disabled", missing_keys)`), and both pre-call and reactive paths gracefully degrade — pre-call no-ops (image goes through unchanged), reactive falls back to today's strip-images behavior.

Per-agent opt-in (no env vars needed beyond the above):

```bash
# CLI / SDK
letta agents update <id> --capability-overrides '{"vision":"unsupported"}'
```

Or in agent state JSON:

```json
{
  "llm_config": {
    "model": "kimi-k2.6",
    "capability_overrides": { "vision": "unsupported" }
  }
}
```

## Data flow

**Pre-call mode** (`vision = "unsupported"`):

1. Agent step starts. Builds pydantic message list as today.
2. Caller checks `llm_config.vision_capability()`. Sees `"unsupported"`. Passes `image_describer=auxiliary_client.describe_image` (sync) into `to_openai_dicts_from_list`.
3. Serializer encounters an `image_url` content part. For each part:
   - Compute `content_hash = sha256(image_bytes)` from the data URL.
   - Cache lookup. Hit → use cached description. Miss → call aux model with the data URL, cache the result.
   - Inline `{"type": "text", "text": f"[Image (auto-described): {description}]"}` into the message body. Skip the synthetic image-only user message generation.
4. Serialized messages — text-only, no `image_url` parts — go to the LLM. No reactive retry path triggers; the LLM sees only text.

**Reactive mode** (`vision = "auto"`, default):

1. Agent step builds messages. `image_describer=None`. Serializer keeps `image_url` parts intact (existing logic produces the synthetic image-only user message as today).
2. Send to LLM with images.
3. Either:
   - Response succeeds → done, agent step continues.
   - HTTP 400 with vision-incapability marker → retry hook fires.
   - 200 OK with empty-stream-after-image → `_EmptyImageResponseRetryStream` retry-factory fires.
4. Retry hook calls `_replace_images_with_descriptions(messages)`:
   - For each `image_url` part: cache lookup → call aux on miss → replace with `[Image (auto-described): …]` text.
   - On `AuxUnavailable` (aux config missing or aux call failed): fall back to `_strip_tool_return_image_messages` (today's behavior).
5. Re-issue the LLM call with the rewritten message list. Whatever happens at this point, the agent step gets a coherent text response and never freezes.

## Error handling

| Condition | Behavior |
|---|---|
| `LETTA_AUX_VISION_*` env vars missing | `_resolve_aux_config` returns `None`. `describe_image` raises `AuxUnavailable`. Pre-call path no-ops (image goes unchanged). Reactive path falls back to `_strip_tool_return_image_messages`. Single warning per process. |
| Aux call HTTP 4xx / 5xx / network error | `describe_image` raises `AuxUnavailable`. Pre-call path's `_safely_describe` inlines `[Image (auto-description failed)]`. Reactive path falls back to `_strip_tool_return_image_messages`. Both log a warning with the underlying error. Main agent step never blocks. |
| Aux returns empty / whitespace-only string | Inline whatever was returned (don't retry, avoid loops). |
| Cache eviction during step | Next aux call re-describes; no correctness impact. |
| Image bytes malformed / not decodable | `describe_image` raises `AuxUnavailable`; same fallback as aux call failure. |
| Pre-call mode + reactive retry on the same message list | Reactive retry no-ops because images already replaced (idempotent — `_replace_images_with_descriptions` returns identical list). |

## Testing

### Unit tests (new file `tests/test_auxiliary_client.py`, ~15 cases)

- `_resolve_aux_config` returns `AuxConfig` when all three env vars set
- `_resolve_aux_config` returns `None` when any env var missing
- `_resolve_aux_config` falls back to `OPENAI_API_KEY` when `LETTA_AUX_VISION_API_KEY` unset
- `describe_image` happy path (mocked OpenAI client) — returns model output
- `describe_image` cache hit on second call with same image
- `describe_image` cache miss on different image / different aux model
- `describe_image` raises `AuxUnavailable` when config missing
- `describe_image` raises `AuxUnavailable` when aux call returns 4xx / 5xx
- `describe_image_async` mirrors sync behavior
- LRU eviction at 257th distinct entry
- Cache thread-safety smoke test (concurrent describe calls)

### Schema tests (in `tests/test_llm_config.py` or equivalent)

- `LLMConfig.capability_overrides` defaults to `{}`
- `vision_capability()` returns `"auto"` when key absent
- `vision_capability()` returns the configured value when key present
- Round-trip serialization preserves `capability_overrides`

### Integration tests (extend `tests/test_chat_completions_tool_return_images.py`)

- Pre-call: `to_openai_dicts_from_list(messages, image_describer=mock)` replaces `image_url` parts with description text and does not emit synthetic image-only user message
- Pre-call: `image_describer=None` produces today's output (regression)
- Reactive: vision-400 with aux configured → calls aux → retries with descriptions
- Reactive: vision-400 with aux unconfigured → falls back to strip-images (today's behavior)
- Reactive: empty-stream-after-image with aux configured → retries with descriptions
- Reactive: empty-stream-after-image with aux unconfigured → falls back to strip-images
- Reactive: aux call itself fails → falls back to strip-images, logs warning, retry still happens
- Idempotency: a message list that has already been aux-replaced is unchanged on second pass

### Existing test migration

The current `_strip_tool_return_image_messages`-based retry tests stay green: they cover the *fallback* path (aux unconfigured → strip). New tests cover the new primary path (aux configured → describe).

## Acceptance criteria

1. With `LETTA_AUX_VISION_*` set and an agent using `kimi-k2.6` on crof.ai with `capability_overrides.vision = "unsupported"`: sending `Read` of an image file produces a coherent agent response describing the image. No empty-stream failures.
2. With the same env vars set and a *different* agent on a vision-capable model with `capability_overrides.vision = "auto"`: image is sent as `image_url` to the main model, no aux call happens, agent describes image natively. (Regression check.)
3. With `LETTA_AUX_VISION_*` *not* set and the same kimi+crof agent: the agent gracefully degrades to today's strip-images behavior, returns a coherent text response (without the image content), never freezes. Single `auxiliary_client: ... not configured` warning logged per process.
4. Same image read in two sibling steps: the second call hits the description cache, no second aux HTTP request issued.
5. All existing `tests/test_chat_completions_tool_return_images.py` cases pass (35 → 35+ as new tests are added).

## Migration / rollout

1. Land the module + schema field + tests on a feature branch off `snowctl/main`.
2. Push to forgejo, fast-forward `snowctl/main`.
3. Rebuild the Docker image on cypher (same flow as commit `239561ae`).
4. Restart letta-server. Set `LETTA_AUX_VISION_*` in `~/Argos/.env`. Set `capability_overrides.vision = "unsupported"` on the kimi-k2.6 agent.
5. Verify with the actual problem: send an image via the agent's matrix bot, confirm the agent describes it. Confirm cache hit on a second send of the same image (server logs).
6. Leave the agent on `capability_overrides.vision = "unsupported"` permanently. Pre-call is both more reliable AND more efficient than reactive for this provider — every image-bearing turn under reactive mode would otherwise pay one wasted main call (full prompt billing on the failed empty-stream response) before the retry. Reactive is the safety net for *unknown* providers, not the default for known-broken ones.
7. Optional follow-up: separately exercise the reactive path on a different agent (e.g. set up a one-off agent on a vision-capable model that you can occasionally toggle to "unsupported"-then-back-to-"auto" in a test) to verify the empty-stream / 400 retry hooks work end-to-end.
8. Optional follow-up: when crof.ai fixes the kimi+system bug, re-test with `vision = "auto"` to confirm native vision works again. Until then, no need to revert.
