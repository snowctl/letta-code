# Auxiliary Image Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a vision-fallback path to letta server that routes images through a configurable auxiliary model when the main model can't (or shouldn't) handle them, both per-agent (`capability_overrides.vision = "unsupported"`) and reactively (on empty-stream / vision-marker 400).

**Architecture:** A new `letta/llm_api/auxiliary_client.py` module exposes sync and async `describe_image(data_url)` helpers backed by an LRU cache keyed by `(task, sha256(image_bytes), aux_model)`. Two existing serialization functions (`Message.to_openai_dicts_from_list` for tool-return images and `fill_image_content_in_messages` for user-upload images) gain an `image_describer` kwarg. The reactive retry hooks already in `openai_client.py` swap their retry factory from `_strip_tool_return_image_messages` to `_replace_images_with_descriptions`, with strip preserved as a final fallback when aux is unconfigured or fails. `OpenAIClient.build_request_data` is the single caller wiring point — both serializer calls live there, so one conditional sets up the describer for the whole pre-call pass.

**Tech Stack:** Python 3.11, Pydantic v2, OpenAI SDK (`openai>=1.x` — sync `OpenAI` and async `AsyncOpenAI` clients), pytest, `uv` for deps. Tests use `--noconftest` consistently due to env-specific conftest issues (mirrors prior work in `tests/test_chat_completions_tool_return_images.py`).

**Repo:** `git@github.com:Projects/letta.git`. The implementer should set up a fresh worktree off `snowctl/main`:
```bash
cd /path/to/letta
git fetch snowctl
git worktree add .worktrees/aux-vision -b feat/auxiliary-image-support snowctl/main
cd .worktrees/aux-vision
uv sync --frozen --no-dev --all-extras --python 3.11
uv pip install pytest pytest-asyncio
```

Run tests with `uv run pytest --noconftest tests/<file>.py -q`.

**Spec:** [`docs/superpowers/specs/2026-04-30-auxiliary-image-support-design.md`](../specs/2026-04-30-auxiliary-image-support-design.md) (in the letta-code repo)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `letta/errors.py` | Modify | Add `AuxUnavailable` exception |
| `letta/llm_api/auxiliary_client.py` | Create | `AuxConfig`, `AuxTask`, cache, `describe_image`, `describe_image_async`, envelope formatters |
| `letta/schemas/llm_config.py` | Modify | Add `capability_overrides: Dict[str, str]` field + `vision_capability()` helper |
| `letta/schemas/message.py` | Modify | `to_openai_dicts_from_list`: new `image_describer` kwarg; emit envelope into tool body when provided |
| `letta/llm_api/openai_client.py` | Modify | `fill_image_content_in_messages`: new `image_describer` kwarg; new `_replace_images_with_descriptions` (sync) + `_replace_images_with_descriptions_async`; swap retry factories in 3 reactive hooks; wire `image_describer` in `build_request_data` |
| `tests/test_auxiliary_client.py` | Create | Unit tests for the new module |
| `tests/test_llm_config.py` | Modify *or* create | Schema tests for `capability_overrides` |
| `tests/test_chat_completions_tool_return_images.py` | Modify | New tests for the aux-described paths; existing tests stay green as fallback path |

---

## Task 1: Add `AuxUnavailable` error

**Files:**
- Modify: `letta/errors.py`
- Test: `tests/test_auxiliary_client.py` (created in Task 2)

Single-purpose: a typed exception that the rest of the module raises and callers catch. Used by `describe_image` whenever aux config is missing or the upstream call fails for any reason.

- [ ] **Step 1: Add the exception class to `letta/errors.py`**

Find the existing exception classes in `letta/errors.py` and append:

```python
class AuxUnavailable(Exception):
    """Raised when an auxiliary task (vision, …) cannot be performed.

    Either the task is not configured (env vars missing) or the upstream
    call failed. Callers should catch this and fall back to a graceful
    degradation path — not propagate to the agent step."""
```

- [ ] **Step 2: Verify the import resolves**

```bash
uv run python -c "from letta.errors import AuxUnavailable; print(AuxUnavailable)"
```

Expected: `<class 'letta.errors.AuxUnavailable'>`

- [ ] **Step 3: Commit**

```bash
git add letta/errors.py
git commit -m "feat(errors): add AuxUnavailable for auxiliary task failures"
```

---

## Task 2: `auxiliary_client.py` — config resolution

**Files:**
- Create: `letta/llm_api/auxiliary_client.py`
- Create: `tests/test_auxiliary_client.py`

Bare-bones module with the enum, dataclass, and resolver. No cache or HTTP yet — that comes in Tasks 3 and 4.

- [ ] **Step 1: Write the failing tests for `_resolve_aux_config`**

Create `tests/test_auxiliary_client.py`:

```python
import os
import pytest
from letta.llm_api.auxiliary_client import AuxConfig, AuxTask, _resolve_aux_config


def _clear_aux_env(monkeypatch):
    for k in (
        "LETTA_AUX_VISION_BASE_URL",
        "LETTA_AUX_VISION_MODEL",
        "LETTA_AUX_VISION_API_KEY",
        "LETTA_AUX_VISION_PROMPT",
        "OPENAI_BASE_URL",
        "OPENAI_API_KEY",
    ):
        monkeypatch.delenv(k, raising=False)


def test_resolve_aux_config_returns_config_when_all_vars_set(monkeypatch):
    _clear_aux_env(monkeypatch)
    monkeypatch.setenv("LETTA_AUX_VISION_BASE_URL", "https://crof.ai/v1")
    monkeypatch.setenv("LETTA_AUX_VISION_MODEL", "qwen3.6-27b")
    monkeypatch.setenv("LETTA_AUX_VISION_API_KEY", "sk-test")

    cfg = _resolve_aux_config(AuxTask.VISION)
    assert cfg == AuxConfig(base_url="https://crof.ai/v1", model="qwen3.6-27b", api_key="sk-test")


def test_resolve_aux_config_returns_none_when_model_missing(monkeypatch):
    _clear_aux_env(monkeypatch)
    monkeypatch.setenv("LETTA_AUX_VISION_BASE_URL", "https://crof.ai/v1")
    monkeypatch.setenv("LETTA_AUX_VISION_API_KEY", "sk-test")
    # Model intentionally unset

    assert _resolve_aux_config(AuxTask.VISION) is None


def test_resolve_aux_config_falls_back_to_openai_base_url(monkeypatch):
    _clear_aux_env(monkeypatch)
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    monkeypatch.setenv("LETTA_AUX_VISION_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("LETTA_AUX_VISION_API_KEY", "sk-test")

    cfg = _resolve_aux_config(AuxTask.VISION)
    assert cfg is not None
    assert cfg.base_url == "https://api.openai.com/v1"


def test_resolve_aux_config_falls_back_to_openai_api_key(monkeypatch):
    _clear_aux_env(monkeypatch)
    monkeypatch.setenv("LETTA_AUX_VISION_BASE_URL", "https://crof.ai/v1")
    monkeypatch.setenv("LETTA_AUX_VISION_MODEL", "qwen3.6-27b")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-fallback")

    cfg = _resolve_aux_config(AuxTask.VISION)
    assert cfg is not None
    assert cfg.api_key == "sk-fallback"


def test_resolve_aux_config_letta_var_takes_precedence_over_openai(monkeypatch):
    _clear_aux_env(monkeypatch)
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-fallback")
    monkeypatch.setenv("LETTA_AUX_VISION_BASE_URL", "https://crof.ai/v1")
    monkeypatch.setenv("LETTA_AUX_VISION_API_KEY", "sk-aux-specific")
    monkeypatch.setenv("LETTA_AUX_VISION_MODEL", "qwen3.6-27b")

    cfg = _resolve_aux_config(AuxTask.VISION)
    assert cfg.base_url == "https://crof.ai/v1"
    assert cfg.api_key == "sk-aux-specific"


def test_aux_task_enum_values():
    assert AuxTask.VISION.value == "vision"
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
uv run pytest --noconftest tests/test_auxiliary_client.py -q
```

Expected: 6 fails (`ModuleNotFoundError: letta.llm_api.auxiliary_client`).

- [ ] **Step 3: Create `letta/llm_api/auxiliary_client.py`**

```python
"""Auxiliary task client — currently supports vision-description fallback
when the main agent model cannot (or should not) handle images directly.

The module is shaped for forward extension to additional auxiliary tasks
(compression, web extraction, etc.) without restructuring: see ``AuxTask``.

Designed in `docs/superpowers/specs/2026-04-30-auxiliary-image-support-design.md`
in the letta-code repo.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from typing import Optional


class AuxTask(str, Enum):
    """Auxiliary task types. Add new members as additional aux tasks land."""

    VISION = "vision"


@dataclass(frozen=True)
class AuxConfig:
    """Resolved configuration for an aux task call: where to send and as whom."""

    base_url: str
    model: str
    api_key: str


def _resolve_aux_config(task: AuxTask) -> Optional[AuxConfig]:
    """Read env vars for *task*, returning None when configuration is incomplete.

    Resolution order per field:
      base_url: LETTA_AUX_<TASK>_BASE_URL → OPENAI_BASE_URL
      api_key:  LETTA_AUX_<TASK>_API_KEY  → OPENAI_API_KEY
      model:    LETTA_AUX_<TASK>_MODEL    → (no fallback; must be explicit)

    Returns None if any field cannot be resolved. Callers must treat None as
    "auxiliary not configured" and degrade gracefully.
    """
    prefix = f"LETTA_AUX_{task.value.upper()}"
    base_url = os.environ.get(f"{prefix}_BASE_URL") or os.environ.get("OPENAI_BASE_URL")
    api_key = os.environ.get(f"{prefix}_API_KEY") or os.environ.get("OPENAI_API_KEY")
    model = os.environ.get(f"{prefix}_MODEL")
    if not (base_url and api_key and model):
        return None
    return AuxConfig(base_url=base_url, model=model, api_key=api_key)
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
uv run pytest --noconftest tests/test_auxiliary_client.py -q
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add letta/llm_api/auxiliary_client.py tests/test_auxiliary_client.py
git commit -m "feat(auxiliary_client): scaffold module with config resolver"
```

---

## Task 3: `describe_image` (sync) with content-hash cache

**Files:**
- Modify: `letta/llm_api/auxiliary_client.py`
- Modify: `tests/test_auxiliary_client.py`

Adds the sync entry point that the pre-call serializer uses. Cache is built in here; async will share it in Task 4.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_auxiliary_client.py`:

```python
import base64
import hashlib
from unittest.mock import MagicMock, patch

from letta.errors import AuxUnavailable
from letta.llm_api.auxiliary_client import (
    DEFAULT_VISION_PROMPT,
    _CACHE,
    describe_image,
)


def _png_data_url(payload: bytes = b"hello-png-bytes") -> str:
    return "data:image/png;base64," + base64.b64encode(payload).decode()


def _set_aux_env(monkeypatch, model="qwen3.6-27b"):
    for k in ("LETTA_AUX_VISION_BASE_URL", "LETTA_AUX_VISION_MODEL", "LETTA_AUX_VISION_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("LETTA_AUX_VISION_BASE_URL", "https://aux.example/v1")
    monkeypatch.setenv("LETTA_AUX_VISION_MODEL", model)
    monkeypatch.setenv("LETTA_AUX_VISION_API_KEY", "sk-test")


def _mock_aux_response(text: str) -> MagicMock:
    """Build a ChatCompletion-shaped mock that returns *text*."""
    msg = MagicMock(); msg.content = text
    choice = MagicMock(); choice.message = msg
    resp = MagicMock(); resp.choices = [choice]
    return resp


@pytest.fixture(autouse=True)
def _clear_cache():
    _CACHE.clear()
    yield
    _CACHE.clear()


def test_describe_image_happy_path(monkeypatch):
    _set_aux_env(monkeypatch)
    fake = MagicMock()
    fake.chat.completions.create.return_value = _mock_aux_response("a green checkmark")
    monkeypatch.setattr("letta.llm_api.auxiliary_client.OpenAI", lambda **_: fake)

    out = describe_image(_png_data_url())

    assert out == "a green checkmark"
    fake.chat.completions.create.assert_called_once()
    kwargs = fake.chat.completions.create.call_args.kwargs
    assert kwargs["model"] == "qwen3.6-27b"
    msgs = kwargs["messages"]
    assert len(msgs) == 1 and msgs[0]["role"] == "user"
    parts = msgs[0]["content"]
    assert parts[0] == {"type": "text", "text": DEFAULT_VISION_PROMPT}
    assert parts[1]["type"] == "image_url"


def test_describe_image_uses_custom_prompt(monkeypatch):
    _set_aux_env(monkeypatch)
    fake = MagicMock()
    fake.chat.completions.create.return_value = _mock_aux_response("ok")
    monkeypatch.setattr("letta.llm_api.auxiliary_client.OpenAI", lambda **_: fake)

    describe_image(_png_data_url(), prompt="One word only.")

    parts = fake.chat.completions.create.call_args.kwargs["messages"][0]["content"]
    assert parts[0] == {"type": "text", "text": "One word only."}


def test_describe_image_uses_env_prompt_when_set(monkeypatch):
    _set_aux_env(monkeypatch)
    monkeypatch.setenv("LETTA_AUX_VISION_PROMPT", "Env-overridden prompt.")
    fake = MagicMock()
    fake.chat.completions.create.return_value = _mock_aux_response("ok")
    monkeypatch.setattr("letta.llm_api.auxiliary_client.OpenAI", lambda **_: fake)

    describe_image(_png_data_url())

    parts = fake.chat.completions.create.call_args.kwargs["messages"][0]["content"]
    assert parts[0] == {"type": "text", "text": "Env-overridden prompt."}


def test_describe_image_raises_when_unconfigured(monkeypatch):
    for k in ("LETTA_AUX_VISION_BASE_URL", "LETTA_AUX_VISION_MODEL", "LETTA_AUX_VISION_API_KEY",
              "OPENAI_BASE_URL", "OPENAI_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(AuxUnavailable):
        describe_image(_png_data_url())


def test_describe_image_raises_when_aux_call_fails(monkeypatch):
    _set_aux_env(monkeypatch)
    fake = MagicMock()
    fake.chat.completions.create.side_effect = RuntimeError("boom")
    monkeypatch.setattr("letta.llm_api.auxiliary_client.OpenAI", lambda **_: fake)

    with pytest.raises(AuxUnavailable):
        describe_image(_png_data_url())


def test_describe_image_cache_hit_on_second_call(monkeypatch):
    _set_aux_env(monkeypatch)
    fake = MagicMock()
    fake.chat.completions.create.return_value = _mock_aux_response("cached desc")
    monkeypatch.setattr("letta.llm_api.auxiliary_client.OpenAI", lambda **_: fake)

    url = _png_data_url()
    a = describe_image(url)
    b = describe_image(url)
    assert a == b == "cached desc"
    assert fake.chat.completions.create.call_count == 1


def test_describe_image_cache_miss_on_different_image(monkeypatch):
    _set_aux_env(monkeypatch)
    fake = MagicMock()
    fake.chat.completions.create.side_effect = [
        _mock_aux_response("desc-1"),
        _mock_aux_response("desc-2"),
    ]
    monkeypatch.setattr("letta.llm_api.auxiliary_client.OpenAI", lambda **_: fake)

    a = describe_image(_png_data_url(b"image-a"))
    b = describe_image(_png_data_url(b"image-b"))
    assert a == "desc-1"
    assert b == "desc-2"
    assert fake.chat.completions.create.call_count == 2


def test_describe_image_cache_miss_on_different_aux_model(monkeypatch):
    _set_aux_env(monkeypatch, model="qwen3.6-27b")
    fake = MagicMock()
    fake.chat.completions.create.side_effect = [
        _mock_aux_response("from-qwen"),
        _mock_aux_response("from-other"),
    ]
    monkeypatch.setattr("letta.llm_api.auxiliary_client.OpenAI", lambda **_: fake)

    url = _png_data_url()
    a = describe_image(url)
    monkeypatch.setenv("LETTA_AUX_VISION_MODEL", "other-vision-model")
    b = describe_image(url)
    assert a == "from-qwen"
    assert b == "from-other"
    assert fake.chat.completions.create.call_count == 2
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
uv run pytest --noconftest tests/test_auxiliary_client.py -q
```

Expected: 8 fails (cannot import `DEFAULT_VISION_PROMPT`, `_CACHE`, `describe_image`).

- [ ] **Step 3: Add the implementation to `letta/llm_api/auxiliary_client.py`**

Append (after the `_resolve_aux_config` function):

```python
import base64
import hashlib
import logging
import re
import threading
from collections import OrderedDict
from typing import Tuple

from openai import OpenAI

from letta.errors import AuxUnavailable

logger = logging.getLogger(__name__)


DEFAULT_VISION_PROMPT = (
    "Describe this image concisely (2-4 sentences, ~150 words max). "
    "Transcribe any visible text or code verbatim. "
    "For charts or diagrams: include axis labels, legend, and key values. "
    "Be factual; skip decorative details (colors, mood, style) unless they convey meaning."
)

_CACHE_MAX = 256
_CACHE: "OrderedDict[Tuple[str, str, str], str]" = OrderedDict()
_CACHE_LOCK = threading.Lock()

# Module-level flag so we only warn once per process about missing config.
_unconfigured_warned = False


def _content_hash(data_url: str) -> str:
    """Extract the base64 image bytes from a data URL and return their sha256."""
    m = re.match(r"data:[^;]+;base64,(.+)$", data_url, flags=re.DOTALL)
    if not m:
        raise AuxUnavailable("auxiliary_client: image data URL is malformed")
    try:
        raw = base64.b64decode(m.group(1), validate=False)
    except Exception as exc:
        raise AuxUnavailable(f"auxiliary_client: image base64 decode failed: {exc}") from exc
    return hashlib.sha256(raw).hexdigest()


def _cache_get(key: Tuple[str, str, str]) -> Optional[str]:
    with _CACHE_LOCK:
        if key not in _CACHE:
            return None
        # Mark as most-recently-used.
        _CACHE.move_to_end(key)
        return _CACHE[key]


def _cache_put(key: Tuple[str, str, str], value: str) -> None:
    with _CACHE_LOCK:
        _CACHE[key] = value
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)


def _warn_unconfigured_once(missing_field: str) -> None:
    global _unconfigured_warned
    if _unconfigured_warned:
        return
    _unconfigured_warned = True
    logger.warning(
        "auxiliary_client: vision auxiliary disabled — missing %s "
        "(set LETTA_AUX_VISION_BASE_URL/_MODEL/_API_KEY or fall back via OPENAI_BASE_URL/OPENAI_API_KEY)",
        missing_field,
    )


def _aux_messages(prompt: str, data_url: str) -> list:
    """Build the stateless one-shot user message for the aux call."""
    return [{
        "role": "user",
        "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": data_url}},
        ],
    }]


def describe_image(data_url: str, *, prompt: Optional[str] = None) -> str:
    """Describe an image via the auxiliary vision model.

    Stateless: constructs its own minimal request — no agent state, no
    conversation history, no tools. Cached by (task, sha256(image_bytes),
    aux_model). Raises AuxUnavailable on any failure; callers must catch
    and degrade gracefully.
    """
    cfg = _resolve_aux_config(AuxTask.VISION)
    if cfg is None:
        _warn_unconfigured_once("LETTA_AUX_VISION_*")
        raise AuxUnavailable("auxiliary_client: vision auxiliary not configured")

    chosen_prompt = prompt if prompt is not None else os.environ.get(
        "LETTA_AUX_VISION_PROMPT", DEFAULT_VISION_PROMPT
    )

    key = (AuxTask.VISION.value, _content_hash(data_url), cfg.model)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    try:
        client = OpenAI(api_key=cfg.api_key, base_url=cfg.base_url)
        resp = client.chat.completions.create(
            model=cfg.model,
            messages=_aux_messages(chosen_prompt, data_url),
            max_tokens=500,
        )
        text = (resp.choices[0].message.content or "").strip()
    except AuxUnavailable:
        raise
    except Exception as exc:
        logger.warning("auxiliary_client: describe_image failed: %s", exc)
        raise AuxUnavailable(f"auxiliary_client: describe_image failed: {exc}") from exc

    _cache_put(key, text)
    return text
```

Note: this requires `from typing import Optional` if not already imported — make sure the file has `from typing import Optional, Tuple` at the top.

- [ ] **Step 4: Run tests and verify they pass**

```bash
uv run pytest --noconftest tests/test_auxiliary_client.py -q
```

Expected: 14 passed (6 from Task 2 + 8 new).

- [ ] **Step 5: Commit**

```bash
git add letta/llm_api/auxiliary_client.py tests/test_auxiliary_client.py
git commit -m "feat(auxiliary_client): add describe_image (sync) with content-hash cache"
```

---

## Task 4: `describe_image_async` sharing the same cache

**Files:**
- Modify: `letta/llm_api/auxiliary_client.py`
- Modify: `tests/test_auxiliary_client.py`

The async variant used by openai-client retry hooks. Shares the cache so a description fetched via the sync path on a previous turn is hit on the async path of a later turn (and vice versa).

- [ ] **Step 1: Write failing tests**

Append to `tests/test_auxiliary_client.py`:

```python
import asyncio
from unittest.mock import AsyncMock

from letta.llm_api.auxiliary_client import describe_image_async


def _async_mock_response(text: str):
    msg = MagicMock(); msg.content = text
    choice = MagicMock(); choice.message = msg
    resp = MagicMock(); resp.choices = [choice]
    return resp


def test_describe_image_async_happy_path(monkeypatch):
    _set_aux_env(monkeypatch)
    fake = MagicMock()
    fake.chat.completions.create = AsyncMock(return_value=_async_mock_response("async desc"))
    monkeypatch.setattr("letta.llm_api.auxiliary_client.AsyncOpenAI", lambda **_: fake)

    out = asyncio.new_event_loop().run_until_complete(describe_image_async(_png_data_url()))

    assert out == "async desc"
    fake.chat.completions.create.assert_awaited_once()


def test_describe_image_async_raises_when_unconfigured(monkeypatch):
    for k in ("LETTA_AUX_VISION_BASE_URL", "LETTA_AUX_VISION_MODEL", "LETTA_AUX_VISION_API_KEY",
              "OPENAI_BASE_URL", "OPENAI_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(AuxUnavailable):
        asyncio.new_event_loop().run_until_complete(describe_image_async(_png_data_url()))


def test_describe_image_async_raises_on_aux_call_failure(monkeypatch):
    _set_aux_env(monkeypatch)
    fake = MagicMock()
    fake.chat.completions.create = AsyncMock(side_effect=RuntimeError("upstream-fail"))
    monkeypatch.setattr("letta.llm_api.auxiliary_client.AsyncOpenAI", lambda **_: fake)

    with pytest.raises(AuxUnavailable):
        asyncio.new_event_loop().run_until_complete(describe_image_async(_png_data_url()))


def test_describe_image_async_shares_cache_with_sync(monkeypatch):
    """A description put in the cache by sync path is reused by async path."""
    _set_aux_env(monkeypatch)
    sync_fake = MagicMock()
    sync_fake.chat.completions.create.return_value = _mock_aux_response("shared cache")
    monkeypatch.setattr("letta.llm_api.auxiliary_client.OpenAI", lambda **_: sync_fake)

    async_fake = MagicMock()
    async_fake.chat.completions.create = AsyncMock(side_effect=AssertionError("must not be called"))
    monkeypatch.setattr("letta.llm_api.auxiliary_client.AsyncOpenAI", lambda **_: async_fake)

    url = _png_data_url(b"shared-bytes")
    sync_out = describe_image(url)
    async_out = asyncio.new_event_loop().run_until_complete(describe_image_async(url))
    assert sync_out == async_out == "shared cache"
    async_fake.chat.completions.create.assert_not_awaited()
    assert sync_fake.chat.completions.create.call_count == 1
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
uv run pytest --noconftest tests/test_auxiliary_client.py -q
```

Expected: 4 fails (`describe_image_async` not defined).

- [ ] **Step 3: Add the async implementation to `letta/llm_api/auxiliary_client.py`**

Append:

```python
from openai import AsyncOpenAI


async def describe_image_async(data_url: str, *, prompt: Optional[str] = None) -> str:
    """Async mirror of describe_image. Shares the same LRU cache."""
    cfg = _resolve_aux_config(AuxTask.VISION)
    if cfg is None:
        _warn_unconfigured_once("LETTA_AUX_VISION_*")
        raise AuxUnavailable("auxiliary_client: vision auxiliary not configured")

    chosen_prompt = prompt if prompt is not None else os.environ.get(
        "LETTA_AUX_VISION_PROMPT", DEFAULT_VISION_PROMPT
    )

    key = (AuxTask.VISION.value, _content_hash(data_url), cfg.model)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    try:
        client = AsyncOpenAI(api_key=cfg.api_key, base_url=cfg.base_url)
        resp = await client.chat.completions.create(
            model=cfg.model,
            messages=_aux_messages(chosen_prompt, data_url),
            max_tokens=500,
        )
        text = (resp.choices[0].message.content or "").strip()
    except AuxUnavailable:
        raise
    except Exception as exc:
        logger.warning("auxiliary_client: describe_image_async failed: %s", exc)
        raise AuxUnavailable(f"auxiliary_client: describe_image_async failed: {exc}") from exc

    _cache_put(key, text)
    return text
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
uv run pytest --noconftest tests/test_auxiliary_client.py -q
```

Expected: 18 passed.

- [ ] **Step 5: Commit**

```bash
git add letta/llm_api/auxiliary_client.py tests/test_auxiliary_client.py
git commit -m "feat(auxiliary_client): add describe_image_async sharing the sync cache"
```

---

## Task 5: LRU eviction explicit test

**Files:**
- Modify: `tests/test_auxiliary_client.py`

LRU behavior is in the implementation already; this task locks it down with a pinpoint test so a future refactor can't break it silently.

- [ ] **Step 1: Add the test**

Append to `tests/test_auxiliary_client.py`:

```python
def test_cache_lru_evicts_oldest_at_257th_entry(monkeypatch):
    _set_aux_env(monkeypatch)
    counter = {"n": 0}

    def _mk_response(*_, **__):
        counter["n"] += 1
        return _mock_aux_response(f"desc-{counter['n']}")

    fake = MagicMock()
    fake.chat.completions.create.side_effect = _mk_response
    monkeypatch.setattr("letta.llm_api.auxiliary_client.OpenAI", lambda **_: fake)

    # Fill cache to capacity (256 entries, distinct images).
    first_url = _png_data_url(b"image-0000")
    describe_image(first_url)
    for i in range(1, 256):
        describe_image(_png_data_url(f"image-{i:04d}".encode()))

    # 257th distinct image → first_url should now be evicted.
    describe_image(_png_data_url(b"image-257"))

    # Re-requesting first_url must trigger a fresh aux call.
    pre = fake.chat.completions.create.call_count
    describe_image(first_url)
    post = fake.chat.completions.create.call_count
    assert post == pre + 1, "LRU eviction did not occur — first entry was still cached"
```

- [ ] **Step 2: Run the test and verify it passes**

```bash
uv run pytest --noconftest tests/test_auxiliary_client.py::test_cache_lru_evicts_oldest_at_257th_entry -v
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/test_auxiliary_client.py
git commit -m "test(auxiliary_client): pin LRU eviction at 257th distinct entry"
```

---

## Task 6: Envelope formatters

**Files:**
- Modify: `letta/llm_api/auxiliary_client.py`
- Modify: `tests/test_auxiliary_client.py`

The two helpers that produce the `<system-interrupt>`-wrapped envelope text. Used by the serializer (Task 7) and the openai-client rewrite helpers (Task 9).

- [ ] **Step 1: Write failing tests**

Append to `tests/test_auxiliary_client.py`:

```python
from letta.llm_api.auxiliary_client import (
    AUX_FAILURE_PLACEHOLDER,
    format_tool_image_envelope,
    format_user_image_envelope,
)


def test_format_tool_image_envelope_wraps_in_system_interrupt():
    out = format_tool_image_envelope("a green checkmark")
    assert out == (
        "<system-interrupt>\n"
        "The active model cannot view images directly; an auto-generated description follows. "
        "Description: a green checkmark\n"
        "</system-interrupt>"
    )


def test_format_user_image_envelope_includes_filename():
    out = format_user_image_envelope("dog.png", "a golden retriever")
    assert out == (
        "[Image attached by user: dog.png]\n"
        "<system-interrupt>\n"
        "The active model cannot view images directly; an auto-generated description follows. "
        "Description: a golden retriever\n"
        "</system-interrupt>"
    )


def test_format_user_image_envelope_unknown_filename():
    out = format_user_image_envelope(None, "some image")
    assert out.startswith("[Image attached by user: unknown]")


def test_aux_failure_placeholder_is_system_interrupt_wrapped():
    assert AUX_FAILURE_PLACEHOLDER == (
        "<system-interrupt>"
        "The active model cannot view images directly, "
        "and the auto-description service is unavailable. "
        "The original image is not visible to the current model."
        "</system-interrupt>"
    )
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
uv run pytest --noconftest tests/test_auxiliary_client.py -q
```

Expected: 4 fails (formatters not defined).

- [ ] **Step 3: Add the formatters to `letta/llm_api/auxiliary_client.py`**

Append:

```python
def format_tool_image_envelope(description: str) -> str:
    """Wrap an auto-description for a tool-return image in a <system-interrupt> tag.

    The source label (e.g. "[Image: foo.png]") is produced by the upstream tool
    and lives outside this envelope.
    """
    return (
        "<system-interrupt>\n"
        "The active model cannot view images directly; an auto-generated description follows. "
        f"Description: {description}\n"
        "</system-interrupt>"
    )


def format_user_image_envelope(filename: Optional[str], description: str) -> str:
    """Wrap an auto-description for a user-uploaded image, including a source label.

    User-supplied caption text (if any) is preserved by the caller — it sits
    above the line returned by this function.
    """
    return (
        f"[Image attached by user: {filename or 'unknown'}]\n"
        "<system-interrupt>\n"
        "The active model cannot view images directly; an auto-generated description follows. "
        f"Description: {description}\n"
        "</system-interrupt>"
    )


AUX_FAILURE_PLACEHOLDER = (
    "<system-interrupt>"
    "The active model cannot view images directly, "
    "and the auto-description service is unavailable. "
    "The original image is not visible to the current model."
    "</system-interrupt>"
)
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
uv run pytest --noconftest tests/test_auxiliary_client.py -q
```

Expected: 22 passed.

- [ ] **Step 5: Commit**

```bash
git add letta/llm_api/auxiliary_client.py tests/test_auxiliary_client.py
git commit -m "feat(auxiliary_client): add envelope formatters and failure placeholder"
```

---

## Task 7: `LLMConfig.capability_overrides`

**Files:**
- Modify: `letta/schemas/llm_config.py`
- Create: `tests/test_llm_config_capability_overrides.py`

A small forward-compatible field on `LLMConfig`. Avoids a flat `vision_capability` field so adding `compression`, `web_extract`, etc. later doesn't need a schema migration.

- [ ] **Step 1: Write failing tests**

Create `tests/test_llm_config_capability_overrides.py`:

```python
import pytest
from letta.schemas.llm_config import LLMConfig


def _mk_config(**overrides):
    return LLMConfig(
        model="kimi-k2.6",
        model_endpoint_type="openai",
        model_endpoint="https://crof.ai/v1",
        context_window=131072,
        **overrides,
    )


def test_capability_overrides_defaults_to_empty_dict():
    cfg = _mk_config()
    assert cfg.capability_overrides == {}


def test_vision_capability_returns_auto_when_unset():
    cfg = _mk_config()
    assert cfg.vision_capability() == "auto"


def test_vision_capability_returns_unsupported_when_set():
    cfg = _mk_config(capability_overrides={"vision": "unsupported"})
    assert cfg.vision_capability() == "unsupported"


def test_vision_capability_returns_supported_when_set():
    cfg = _mk_config(capability_overrides={"vision": "supported"})
    assert cfg.vision_capability() == "supported"


def test_capability_overrides_round_trips_through_serialization():
    cfg = _mk_config(capability_overrides={"vision": "unsupported"})
    payload = cfg.model_dump_json()
    restored = LLMConfig.model_validate_json(payload)
    assert restored.capability_overrides == {"vision": "unsupported"}
    assert restored.vision_capability() == "unsupported"


def test_capability_overrides_accepts_arbitrary_keys():
    cfg = _mk_config(capability_overrides={"vision": "auto", "compression": "supported"})
    assert cfg.capability_overrides == {"vision": "auto", "compression": "supported"}
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
uv run pytest --noconftest tests/test_llm_config_capability_overrides.py -q
```

Expected: 6 fails (field doesn't exist; method doesn't exist).

- [ ] **Step 3: Modify `letta/schemas/llm_config.py`**

Find the `LLMConfig` class definition. Add the new field alongside the existing fields:

```python
from typing import Dict, Literal

# ...inside the LLMConfig class body, add:
    capability_overrides: Dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Optional per-agent capability overrides. Keys are capability "
            "names (e.g. 'vision'); values are 'supported', 'unsupported', "
            "or 'auto' (default if absent). Used to force-disable a "
            "capability on a specific provider — e.g. kimi-k2.6 on crof.ai "
            "currently has a vision bug, so set "
            "{'vision': 'unsupported'} to route images through the "
            "auxiliary describer instead."
        ),
    )

    def vision_capability(self) -> Literal["supported", "unsupported", "auto"]:
        """Returns the vision capability for this config. Defaults to 'auto'.

        'auto' uses the model's native vision support and relies on the
        reactive auxiliary fallback when failures are detected. 'unsupported'
        forces every image through the auxiliary describer pre-call.
        """
        return self.capability_overrides.get("vision", "auto")  # type: ignore[return-value]
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
uv run pytest --noconftest tests/test_llm_config_capability_overrides.py -q
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add letta/schemas/llm_config.py tests/test_llm_config_capability_overrides.py
git commit -m "feat(llm_config): add capability_overrides + vision_capability() helper"
```

---

## Task 8: Wire `image_describer` into `to_openai_dicts_from_list`

**Files:**
- Modify: `letta/schemas/message.py`
- Modify: `tests/test_chat_completions_tool_return_images.py`

The serializer's tool-message branch already extracts `image_data_urls`. When `image_describer` is provided we route those through the describer and inline a `<system-interrupt>` envelope into the tool body, suppressing the synthetic image-only user message that would otherwise be emitted.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_chat_completions_tool_return_images.py`:

```python
from letta.llm_api.auxiliary_client import format_tool_image_envelope


def test_to_openai_dicts_uses_image_describer_when_provided():
    image_part = ImageContent(source=Base64Image(media_type="image/png", data="aGVsbG8="))
    text_part = TextContent(text="[Image: foo.png]")
    tool_msg = _msg(
        MessageRole.tool,
        tool_returns=[ToolReturn(tool_call_id="call_1", status="success",
                                  func_response=[text_part, image_part])],
    )

    captured = {}
    def describer(data_url: str) -> str:
        captured["url"] = data_url
        return "a checkmark and some text"

    result = Message.to_openai_dicts_from_list([tool_msg], image_describer=describer)

    # Only the tool message — no synthetic image-only user message.
    assert len(result) == 1
    assert result[0]["role"] == "tool"
    body = result[0]["content"]
    assert "[Image: foo.png]" in body
    assert format_tool_image_envelope("a checkmark and some text") in body
    # Sanity: describer was called with a data URL containing our base64 bytes.
    assert captured["url"].startswith("data:image/png;base64,aGVsbG8=")


def test_to_openai_dicts_image_describer_failure_substitutes_placeholder():
    from letta.errors import AuxUnavailable
    from letta.llm_api.auxiliary_client import AUX_FAILURE_PLACEHOLDER

    image_part = ImageContent(source=Base64Image(media_type="image/png", data="aGVsbG8="))
    text_part = TextContent(text="[Image: foo.png]")
    tool_msg = _msg(
        MessageRole.tool,
        tool_returns=[ToolReturn(tool_call_id="call_1", status="success",
                                  func_response=[text_part, image_part])],
    )

    def failing_describer(_: str) -> str:
        raise AuxUnavailable("aux down")

    result = Message.to_openai_dicts_from_list([tool_msg], image_describer=failing_describer)

    assert len(result) == 1
    assert result[0]["role"] == "tool"
    assert AUX_FAILURE_PLACEHOLDER in result[0]["content"]


def test_to_openai_dicts_no_describer_unchanged_behavior():
    """Regression: without image_describer, today's behavior is preserved."""
    image_part = ImageContent(source=Base64Image(media_type="image/png", data="aGVsbG8="))
    text_part = TextContent(text="[Image: foo.png]")
    tool_msg = _msg(
        MessageRole.tool,
        tool_returns=[ToolReturn(tool_call_id="call_1", status="success",
                                  func_response=[text_part, image_part])],
    )

    result = Message.to_openai_dicts_from_list([tool_msg])

    # Two dicts: tool + synthetic image-only user msg (today's shape).
    assert len(result) == 2
    assert result[0]["role"] == "tool"
    assert "[Image attached in next message]" in result[0]["content"]
    assert result[1]["role"] == "user"
    assert any(p.get("type") == "image_url" for p in result[1]["content"])
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
uv run pytest --noconftest tests/test_chat_completions_tool_return_images.py -q
```

Expected: 3 new fails (`image_describer` kwarg unknown).

- [ ] **Step 3: Modify `to_openai_dicts_from_list` in `letta/schemas/message.py`**

Find the existing function. The tool-message branch (where `image_urls = Message._tool_return_image_data_urls(tr.func_response)` etc. lives) currently has:

```python
if image_urls:
    n = len(image_urls)
    attached = (
        "[Image attached in next message]"
        if n == 1
        else f"[{n} images attached in next message]"
    )
    text = f"{body_text} {attached}".strip() if body_text else attached
    pending_image_urls.extend(image_urls)
else:
    text = body_text
```

Change the function signature to accept an `image_describer` kwarg, and rewrite that branch:

```python
def to_openai_dicts_from_list(
    messages: List["Message"],
    *,
    max_tool_id_length: Optional[int] = None,
    put_inner_thoughts_in_kwargs: bool = False,
    use_developer_message: bool = False,
    tool_return_truncation_chars: Optional[int] = None,
    image_describer: Optional[Callable[[str], str]] = None,  # NEW
) -> List[dict]:
    ...
```

(Keep all existing kwargs in the same positions — only add `image_describer` at the end.)

Then in the tool-message branch, replace the original `if image_urls:` block with:

```python
if image_urls:
    if image_describer is not None:
        # Pre-call mode — describe each image inline; no synthetic user msg.
        envelopes = [_safely_describe_tool_image(image_describer, u) for u in image_urls]
        joined = "\n\n".join(envelopes)
        text = f"{body_text}\n\n{joined}".strip() if body_text else joined
    else:
        n = len(image_urls)
        attached = (
            "[Image attached in next message]"
            if n == 1
            else f"[{n} images attached in next message]"
        )
        text = f"{body_text} {attached}".strip() if body_text else attached
        pending_image_urls.extend(image_urls)
else:
    text = body_text
```

Add the helper at module scope (top of file alongside the other private helpers):

```python
def _safely_describe_tool_image(image_describer: "Callable[[str], str]", data_url: str) -> str:
    """Wrap describer call so a single aux failure can't poison serialization."""
    from letta.errors import AuxUnavailable
    from letta.llm_api.auxiliary_client import AUX_FAILURE_PLACEHOLDER, format_tool_image_envelope
    try:
        description = image_describer(data_url)
    except AuxUnavailable:
        return AUX_FAILURE_PLACEHOLDER
    return format_tool_image_envelope(description)
```

Also add to the imports at the top of `letta/schemas/message.py`:

```python
from typing import Callable
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
uv run pytest --noconftest tests/test_chat_completions_tool_return_images.py -q
```

Expected: all tests pass (50 existing + 3 new = 53).

- [ ] **Step 5: Commit**

```bash
git add letta/schemas/message.py tests/test_chat_completions_tool_return_images.py
git commit -m "feat(message): wire image_describer into tool-return serialization"
```

---

## Task 9: Wire `image_describer` into `fill_image_content_in_messages`

**Files:**
- Modify: `letta/llm_api/openai_client.py`
- Modify: `tests/test_chat_completions_tool_return_images.py`

The user-upload path. When `image_describer` is provided, the patched user message becomes a single-string content combining the user's caption (if any) with the `<system-interrupt>` envelope. No `image_url` parts in the output.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_chat_completions_tool_return_images.py`:

```python
from letta.llm_api.openai_client import fill_image_content_in_messages
from letta.llm_api.auxiliary_client import format_user_image_envelope, AUX_FAILURE_PLACEHOLDER
from letta.errors import AuxUnavailable
from letta.schemas.letta_message_content import (
    Base64Image, ImageContent, TextContent,
)
from letta.schemas.message import Message
from letta.schemas.enums import MessageRole


def _user_with_image(caption: str, b64: str = "aGVsbG8=") -> Message:
    return Message(
        role=MessageRole.user,
        content=[
            TextContent(text=caption),
            ImageContent(source=Base64Image(media_type="image/png", data=b64)),
        ],
    )


def test_fill_image_uses_describer_for_user_upload(monkeypatch):
    pyd_user = _user_with_image("what do you think of this?")
    openai_dicts = [{"role": "user", "content": "what do you think of this?"}]

    captured = {}
    def describer(data_url: str) -> str:
        captured["url"] = data_url
        return "a golden retriever"

    out = fill_image_content_in_messages(openai_dicts, [pyd_user], image_describer=describer)

    assert len(out) == 1
    assert out[0]["role"] == "user"
    body = out[0]["content"]
    assert isinstance(body, str)
    assert body.startswith("what do you think of this?")
    assert format_user_image_envelope(filename=None, description="a golden retriever").splitlines()[1:] \
        == body.splitlines()[2:]  # envelope lines match
    assert captured["url"].startswith("data:image/png;base64,aGVsbG8=")
    # No image_url part survives in the output.
    assert "image_url" not in body


def test_fill_image_describer_failure_substitutes_placeholder():
    pyd_user = _user_with_image("hi")
    openai_dicts = [{"role": "user", "content": "hi"}]

    def failing_describer(_: str) -> str:
        raise AuxUnavailable("aux down")

    out = fill_image_content_in_messages(openai_dicts, [pyd_user], image_describer=failing_describer)
    assert AUX_FAILURE_PLACEHOLDER in out[0]["content"]


def test_fill_image_no_describer_preserves_existing_behavior():
    pyd_user = _user_with_image("describe this")
    openai_dicts = [{"role": "user", "content": "describe this"}]

    out = fill_image_content_in_messages(openai_dicts, [pyd_user])

    # Existing behavior: multimodal [text, image_url] content.
    assert isinstance(out[0]["content"], list)
    assert any(p.get("type") == "image_url" for p in out[0]["content"])


def test_fill_image_describer_with_no_caption():
    pyd_user = Message(
        role=MessageRole.user,
        content=[ImageContent(source=Base64Image(media_type="image/png", data="aGVsbG8="))],
    )
    openai_dicts = [{"role": "user", "content": ""}]

    out = fill_image_content_in_messages(
        openai_dicts, [pyd_user], image_describer=lambda _: "a logo"
    )
    body = out[0]["content"]
    # No leading user text — envelope is the whole content.
    assert body.startswith("[Image attached by user:")
    assert "<system-interrupt>" in body
    assert "Description: a logo" in body
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
uv run pytest --noconftest tests/test_chat_completions_tool_return_images.py -q
```

Expected: 4 new fails (`image_describer` kwarg unknown).

- [ ] **Step 3: Modify `fill_image_content_in_messages` in `letta/llm_api/openai_client.py`**

The current function (at `letta/llm_api/openai_client.py:1767` on `snowctl/main`) iterates user messages, walks the pydantic content list inline, and pushes a multimodal `[text, image_url]` dict at the bottom of the loop. We want to add an `image_describer` kwarg, and when it's set replace the multimodal-build branch with describer-and-envelope.

Replace the existing function with this version (preserves all behavior when `image_describer is None`):

```python
def fill_image_content_in_messages(
    openai_message_list: List[dict],
    pydantic_message_list: List[PydanticMessage],
    *,
    image_describer: Optional[Callable[[str], str]] = None,
) -> List[dict]:
    """
    Converts image content to openai format.

    Matches user messages by role (not index) to handle length differences
    caused by tool message expansion in to_openai_dicts_from_list.

    When *image_describer* is provided, image content is replaced with an
    auto-generated text description envelope (see auxiliary_client) instead
    of being emitted as image_url parts. Used for vision-unsupported main
    models (`llm_config.capability_overrides.vision = "unsupported"`).
    """
    user_msgs = [m for m in pydantic_message_list if getattr(m, "role", None) == "user"]
    user_idx = 0

    new_message_list = []
    for openai_message in openai_message_list:
        if not (isinstance(openai_message, dict) and openai_message.get("role") == "user") and not (
            hasattr(openai_message, "role") and openai_message.role == "user"
        ):
            new_message_list.append(openai_message)
            continue

        # Skip user messages whose content is already a multi-modal list (e.g.
        # synthetic image_url message produced by to_openai_dicts_from_list for
        # tool-return images). Re-running the pydantic-driven rewrite on these
        # would consume the wrong user_msgs[user_idx] entry.
        existing = openai_message.get("content") if isinstance(openai_message, dict) else getattr(openai_message, "content", None)
        if isinstance(existing, list) and any(
            isinstance(p, dict) and p.get("type") in ("image_url", "input_image") for p in existing
        ):
            new_message_list.append(openai_message)
            continue

        if user_idx >= len(user_msgs):
            new_message_list.append(openai_message)
            continue

        pydantic_message = user_msgs[user_idx]
        user_idx += 1

        if not isinstance(pydantic_message.content, list) or (
            len(pydantic_message.content) == 1 and pydantic_message.content[0].type == MessageContentType.text
        ):
            new_message_list.append(openai_message)
            continue

        # Walk the pydantic content list once, collecting text fragments and
        # image data URLs separately. Both branches below consume these.
        text_fragments: List[str] = []
        image_data_urls: List[str] = []
        for content in pydantic_message.content:
            if content.type == MessageContentType.text:
                text_fragments.append(content.text)
            elif content.type == MessageContentType.image:
                image_data_urls.append(
                    f"data:{content.source.media_type};base64,{content.source.data}"
                )
            else:
                raise ValueError(f"Unsupported content type {content.type}")

        if image_data_urls and image_describer is not None:
            # Pre-call mode — describe each image inline; produce single-string user content.
            filename = _filename_from_pydantic(pydantic_message)
            envelopes = [
                _safely_describe_user_image(image_describer, filename, url)
                for url in image_data_urls
            ]
            user_text = "\n".join(t for t in text_fragments if t)
            parts: List[str] = []
            if user_text:
                parts.append(user_text)
            parts.extend(envelopes)
            new_message_list.append({"role": "user", "content": "\n\n".join(parts)})
            continue

        # Default path: emit OpenAI multimodal `[text, image_url]` content.
        message_content: List[dict] = []
        for content in pydantic_message.content:
            if content.type == MessageContentType.text:
                message_content.append({"type": "text", "text": content.text})
            elif content.type == MessageContentType.image:
                message_content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{content.source.media_type};base64,{content.source.data}",
                        "detail": content.source.detail or "auto",
                    },
                })

        new_message_list.append({"role": "user", "content": message_content})

    return new_message_list
```

Then add the two helpers at module scope (above the function definition is fine):

```python
def _filename_from_pydantic(pyd_msg) -> Optional[str]:
    """Extract a filename hint from a pydantic message's first ImageContent.

    Returns None when no usable filename is present; the envelope formatter
    will substitute "unknown".
    """
    try:
        for part in (pyd_msg.content or []):
            if getattr(part, "type", None) != MessageContentType.image:
                continue
            src = getattr(part, "source", None)
            if src is None:
                continue
            for attr in ("path", "filename", "url"):
                v = getattr(src, attr, None)
                if isinstance(v, str) and v:
                    return v.rsplit("/", 1)[-1]
    except Exception:
        pass
    return None


def _safely_describe_user_image(image_describer, filename, data_url):
    """Wrap describer call so a single aux failure can't poison serialization.
    Returns the user-image envelope on success, or AUX_FAILURE_PLACEHOLDER on AuxUnavailable.
    """
    from letta.errors import AuxUnavailable
    from letta.llm_api.auxiliary_client import AUX_FAILURE_PLACEHOLDER, format_user_image_envelope
    try:
        description = image_describer(data_url)
    except AuxUnavailable:
        return AUX_FAILURE_PLACEHOLDER
    return format_user_image_envelope(filename, description)
```

Make sure `Callable` is imported at the top of the file (`from typing import Callable, ...`).

- [ ] **Step 4: Run tests and verify they pass**

```bash
uv run pytest --noconftest tests/test_chat_completions_tool_return_images.py -q
```

Expected: all green (50 existing + 3 from Task 8 + 4 new = 57).

- [ ] **Step 5: Commit**

```bash
git add letta/llm_api/openai_client.py tests/test_chat_completions_tool_return_images.py
git commit -m "feat(openai_client): wire image_describer into fill_image_content_in_messages"
```

---

## Task 10: `_replace_images_with_descriptions` (sync) for reactive retry

**Files:**
- Modify: `letta/llm_api/openai_client.py`
- Modify: `tests/test_chat_completions_tool_return_images.py`

Sync rewrite helper used by `OpenAIClient.request`'s vision-marker-400 retry path. Operates on the post-serialization openai dict list — finds synthetic image-only user messages, removes them, and appends the envelope to the immediately preceding tool message's body.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_chat_completions_tool_return_images.py`:

```python
from letta.llm_api.openai_client import _replace_images_with_descriptions
from letta.llm_api.auxiliary_client import format_tool_image_envelope


def test_replace_images_with_descriptions_calls_aux_for_each_image(monkeypatch):
    msgs = [
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "Read", "arguments": "{}"}}
        ]},
        {"role": "tool", "tool_call_id": "c1",
         "content": "[Image: foo.png] [Image attached in next message]"},
        {"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,aGVsbG8="}}
        ]},
    ]

    monkeypatch.setattr(
        "letta.llm_api.openai_client.describe_image",
        lambda url: "a checkmark"
    )

    out = _replace_images_with_descriptions(msgs)

    # Synthetic user msg is gone; tool body has envelope appended.
    assert len(out) == 2
    assert out[0]["role"] == "assistant"
    assert out[1]["role"] == "tool"
    assert format_tool_image_envelope("a checkmark") in out[1]["content"]
    # Original "attached in next message" sentinel removed via the existing strip helper.
    assert "Image attached in next message" not in out[1]["content"]


def test_replace_images_falls_back_to_strip_when_aux_unavailable(monkeypatch):
    msgs = [
        {"role": "tool", "tool_call_id": "c1",
         "content": "[Image: foo.png] [Image attached in next message]"},
        {"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,aGVsbG8="}}
        ]},
    ]

    from letta.errors import AuxUnavailable
    def boom(_):
        raise AuxUnavailable("not configured")
    monkeypatch.setattr("letta.llm_api.openai_client.describe_image", boom)

    out = _replace_images_with_descriptions(msgs)

    # Strip-images fallback: synthetic user msg removed, tool body rewritten to "Image omitted".
    assert len(out) == 1
    assert out[0]["role"] == "tool"
    assert "[Image omitted]" in out[0]["content"]


def test_replace_images_idempotent_when_no_synthetic_messages():
    msgs = [
        {"role": "tool", "tool_call_id": "c1", "content": "[Image: foo.png]\n\n<system-interrupt>...</system-interrupt>"},
        {"role": "assistant", "content": "ok"},
    ]
    out = _replace_images_with_descriptions(msgs)
    assert out == msgs
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
uv run pytest --noconftest tests/test_chat_completions_tool_return_images.py -q
```

Expected: 3 new fails (`_replace_images_with_descriptions` not defined).

- [ ] **Step 3: Add the helper to `letta/llm_api/openai_client.py`**

Add near `_strip_tool_return_image_messages` (the existing helper used as the fallback):

```python
def _replace_images_with_descriptions(messages: List[dict]) -> List[dict]:
    """Reactive-retry rewrite: replace synthetic image-only user messages with
    auto-described text, appending the envelope to the preceding tool message.

    Output is structurally identical to what pre-call mode produces. On
    AuxUnavailable from the describer, falls back to
    ``_strip_tool_return_image_messages`` (image content removed entirely,
    sentinel rewritten to "[Image omitted]"). Logs a warning on aux failure
    but never raises.
    """
    from letta.errors import AuxUnavailable
    from letta.llm_api.auxiliary_client import describe_image, format_tool_image_envelope

    out: List[dict] = []
    for msg in messages:
        if _is_synthetic_image_user_dict(msg):
            # Walk backward to the most recent tool message and append envelopes for each image_url part.
            i = len(out) - 1
            tool_idx = None
            while i >= 0:
                if isinstance(out[i], dict) and out[i].get("role") == "tool":
                    tool_idx = i
                    break
                i -= 1

            try:
                envelopes = [
                    format_tool_image_envelope(describe_image(p["image_url"]["url"]))
                    for p in (msg.get("content") or [])
                    if isinstance(p, dict) and p.get("type") == "image_url"
                ]
            except AuxUnavailable as exc:
                logger.warning(
                    "[OpenAI] reactive retry: aux unavailable (%s); falling back to strip-images",
                    exc,
                )
                return _strip_tool_return_image_messages(messages)

            if tool_idx is not None and envelopes:
                tool_body = out[tool_idx].get("content") or ""
                # Remove the "[N images attached in next message]" sentinel from the body.
                cleaned = _ATTACHED_RE.sub("", tool_body).rstrip()
                joined = "\n\n".join(envelopes)
                out[tool_idx] = {**out[tool_idx], "content": f"{cleaned}\n\n{joined}".strip()}
            # Skip appending the synthetic image-only user dict.
            continue
        out.append(msg)
    return out
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
uv run pytest --noconftest tests/test_chat_completions_tool_return_images.py -q
```

Expected: all green (now 60 tests).

- [ ] **Step 5: Commit**

```bash
git add letta/llm_api/openai_client.py tests/test_chat_completions_tool_return_images.py
git commit -m "feat(openai_client): _replace_images_with_descriptions sync rewrite helper"
```

---

## Task 11: `_replace_images_with_descriptions_async` for async/stream retry

**Files:**
- Modify: `letta/llm_api/openai_client.py`
- Modify: `tests/test_chat_completions_tool_return_images.py`

Async mirror used by `request_async` and `stream_async` retry hooks. Same logic — calls `describe_image_async` instead of the sync version.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_chat_completions_tool_return_images.py`:

```python
from letta.llm_api.openai_client import _replace_images_with_descriptions_async


def test_replace_images_async_calls_aux(monkeypatch):
    msgs = [
        {"role": "tool", "tool_call_id": "c1",
         "content": "[Image: foo.png] [Image attached in next message]"},
        {"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,aGVsbG8="}}
        ]},
    ]

    async def fake_describe(url):
        return "a checkmark"
    monkeypatch.setattr("letta.llm_api.openai_client.describe_image_async", fake_describe)

    out = asyncio.new_event_loop().run_until_complete(
        _replace_images_with_descriptions_async(msgs)
    )
    assert len(out) == 1
    assert format_tool_image_envelope("a checkmark") in out[0]["content"]


def test_replace_images_async_falls_back_to_strip_on_aux_unavailable(monkeypatch):
    msgs = [
        {"role": "tool", "tool_call_id": "c1",
         "content": "[Image: foo.png] [Image attached in next message]"},
        {"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,aGVsbG8="}}
        ]},
    ]

    from letta.errors import AuxUnavailable
    async def boom(url):
        raise AuxUnavailable("aux unconfigured")
    monkeypatch.setattr("letta.llm_api.openai_client.describe_image_async", boom)

    out = asyncio.new_event_loop().run_until_complete(
        _replace_images_with_descriptions_async(msgs)
    )
    assert len(out) == 1
    assert "[Image omitted]" in out[0]["content"]
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
uv run pytest --noconftest tests/test_chat_completions_tool_return_images.py -q
```

Expected: 2 new fails.

- [ ] **Step 3: Add the async helper to `letta/llm_api/openai_client.py`**

```python
async def _replace_images_with_descriptions_async(messages: List[dict]) -> List[dict]:
    """Async mirror of _replace_images_with_descriptions — uses describe_image_async."""
    from letta.errors import AuxUnavailable
    from letta.llm_api.auxiliary_client import describe_image_async, format_tool_image_envelope

    out: List[dict] = []
    for msg in messages:
        if _is_synthetic_image_user_dict(msg):
            i = len(out) - 1
            tool_idx = None
            while i >= 0:
                if isinstance(out[i], dict) and out[i].get("role") == "tool":
                    tool_idx = i
                    break
                i -= 1

            try:
                envelopes = []
                for p in (msg.get("content") or []):
                    if isinstance(p, dict) and p.get("type") == "image_url":
                        desc = await describe_image_async(p["image_url"]["url"])
                        envelopes.append(format_tool_image_envelope(desc))
            except AuxUnavailable as exc:
                logger.warning(
                    "[OpenAI] reactive retry async: aux unavailable (%s); falling back to strip-images",
                    exc,
                )
                return _strip_tool_return_image_messages(messages)

            if tool_idx is not None and envelopes:
                tool_body = out[tool_idx].get("content") or ""
                cleaned = _ATTACHED_RE.sub("", tool_body).rstrip()
                joined = "\n\n".join(envelopes)
                out[tool_idx] = {**out[tool_idx], "content": f"{cleaned}\n\n{joined}".strip()}
            continue
        out.append(msg)
    return out
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
uv run pytest --noconftest tests/test_chat_completions_tool_return_images.py -q
```

Expected: all green (62 tests).

- [ ] **Step 5: Commit**

```bash
git add letta/llm_api/openai_client.py tests/test_chat_completions_tool_return_images.py
git commit -m "feat(openai_client): _replace_images_with_descriptions_async helper"
```

---

## Task 12: Swap reactive retry hooks to use the new replace helpers

**Files:**
- Modify: `letta/llm_api/openai_client.py`
- Modify: `tests/test_chat_completions_tool_return_images.py`

Three retry sites today call `_strip_tool_return_image_messages`. Each one swaps to the new replace helper, with strip preserved as the inner fallback (handled inside the replace helpers themselves — Tasks 10 and 11).

- [ ] **Step 1: Update the existing retry tests' assertions**

Find the tests `test_request_retries_with_stripped_messages_on_vision_400`, `test_request_async_retries_with_stripped_messages_on_vision_400`, and `test_stream_async_retries_with_stripped_messages_on_vision_400`. They currently assert the retry uses stripped (text-only) messages. Add assertions for the new aux-described path:

```python
def test_request_retry_uses_aux_describer_when_configured(monkeypatch):
    """When aux is configured, vision-400 retry calls describe_image."""
    from unittest.mock import MagicMock
    fake_client = MagicMock()
    success = MagicMock(); success.model_dump.return_value = {"id": "ok"}
    fake_client.chat.completions.create.side_effect = [
        _make_400("Invalid value: 'image_url' is not supported."),
        success,
    ]
    monkeypatch.setattr("letta.llm_api.openai_client.OpenAI", lambda **_: fake_client)
    monkeypatch.setattr(OpenAIClient, "_prepare_client_kwargs", lambda self, _: {})
    monkeypatch.setattr(
        "letta.llm_api.openai_client.describe_image",
        lambda url: "an aux-described image"
    )

    client = OpenAIClient()
    result = client.request(_request_data_with_synthetic_image(), MagicMock(model="m"))

    assert result == {"id": "ok"}
    second_msgs = fake_client.chat.completions.create.call_args_list[1].kwargs["messages"]
    assert all(
        not (isinstance(m.get("content"), list)
             and any(p.get("type") == "image_url" for p in m["content"]))
        for m in second_msgs
    )
    tool_msg = next(m for m in second_msgs if m.get("role") == "tool")
    assert "an aux-described image" in tool_msg["content"]
    assert "<system-interrupt>" in tool_msg["content"]
```

- [ ] **Step 2: Run tests and verify the new test fails**

```bash
uv run pytest --noconftest tests/test_chat_completions_tool_return_images.py::test_request_retry_uses_aux_describer_when_configured -v
```

Expected: FAIL — current retry calls `_strip_tool_return_image_messages` instead of `_replace_images_with_descriptions`.

- [ ] **Step 3: Modify the three retry sites in `letta/llm_api/openai_client.py`**

In `OpenAIClient.request` (sync, ~line 800):

Find:
```python
            except openai.BadRequestError as e:
                if not _is_vision_incapable_400(e):
                    raise
                stripped = _strip_tool_return_image_messages(request_data.get("messages") or [])
                if stripped == request_data.get("messages"):
                    raise  # Nothing to strip, no point retrying.
                request_data = {**request_data, "messages": stripped}
                logger.warning("[OpenAI] vision-incapable 400; retrying with [Image omitted] fallback")
                response = client.chat.completions.create(**request_data)
                return response.model_dump()
```

Replace with:
```python
            except openai.BadRequestError as e:
                if not _is_vision_incapable_400(e):
                    raise
                rewritten = _replace_images_with_descriptions(request_data.get("messages") or [])
                if rewritten == request_data.get("messages"):
                    raise  # Nothing to rewrite, no point retrying.
                request_data = {**request_data, "messages": rewritten}
                logger.warning("[OpenAI] vision-incapable 400; retrying with auto-description fallback")
                response = client.chat.completions.create(**request_data)
                return response.model_dump()
```

In `OpenAIClient.request_async` (~line 825), make the analogous change but use `_replace_images_with_descriptions_async` and `await` it:

```python
            except openai.BadRequestError as e:
                if not _is_vision_incapable_400(e):
                    raise
                rewritten = await _replace_images_with_descriptions_async(request_data.get("messages") or [])
                if rewritten == request_data.get("messages"):
                    raise
                request_data = {**request_data, "messages": rewritten}
                logger.warning("[OpenAI] vision-incapable 400; retrying with auto-description fallback")
                response = await client.chat.completions.create(**request_data)
                return response.model_dump()
```

In `OpenAIClient.stream_async` (~line 1142), the BadRequestError branch:

```python
            except openai.BadRequestError as e:
                if not _is_vision_incapable_400(e):
                    logger.error(f"Error streaming OpenAI Chat Completions request: {e} with request data: {json.dumps(request_data)}")
                    raise
                rewritten = await _replace_images_with_descriptions_async(request_data.get("messages") or [])
                if rewritten == request_data.get("messages"):
                    logger.error(f"Error streaming OpenAI Chat Completions request: {e} with request data: {json.dumps(request_data)}")
                    raise
                request_data = {**request_data, "messages": rewritten}
                logger.warning("[OpenAI] vision-incapable 400; retrying stream with auto-description fallback")
                response_stream = await client.chat.completions.create(
                    **request_data,
                    stream=True,
                    stream_options={"include_usage": True},
                )
```

And the `_EmptyImageResponseRetryStream` retry factory inside `stream_async` (the inline closure that builds the retry stream):

```python
            messages_for_retry = list(request_data.get("messages") or [])
            if _request_has_image_url(messages_for_retry):
                async def _retry_factory() -> Optional[AsyncStream[ChatCompletionChunk]]:
                    rewritten = await _replace_images_with_descriptions_async(messages_for_retry)
                    if rewritten == messages_for_retry:
                        return None
                    retry_data = {**request_data, "messages": rewritten}
                    return await client.chat.completions.create(
                        **retry_data,
                        stream=True,
                        stream_options={"include_usage": True},
                    )
                return _EmptyImageResponseRetryStream(response_stream, _retry_factory)
```

(The non-vision-marker fallback inside `_EmptyImageResponseRetryStream` already returns the `_strip_tool_return_image_messages` path indirectly because `_replace_images_with_descriptions_async` itself falls back to strip on `AuxUnavailable`.)

- [ ] **Step 4: Run tests and verify they pass**

```bash
uv run pytest --noconftest tests/test_chat_completions_tool_return_images.py -q
```

Expected: all green (63 tests). Existing strip-fallback tests still pass because the new helpers internally call strip when aux is unconfigured.

- [ ] **Step 5: Commit**

```bash
git add letta/llm_api/openai_client.py tests/test_chat_completions_tool_return_images.py
git commit -m "feat(openai_client): swap retry hooks from strip-images to auto-describe"
```

---

## Task 13: Wire the pre-call `image_describer` in `build_request_data`

**Files:**
- Modify: `letta/llm_api/openai_client.py`
- Modify: `tests/test_chat_completions_tool_return_images.py`

The single caller wiring point — both `to_openai_dicts_from_list` and `fill_image_content_in_messages` are called from `OpenAIClient.build_request_data` (around line 593). Pass `image_describer=describe_image` when `llm_config.vision_capability() == "unsupported"`.

- [ ] **Step 1: Write the failing integration test**

Append to `tests/test_chat_completions_tool_return_images.py`:

```python
def test_build_request_data_passes_describer_when_vision_unsupported(monkeypatch):
    """End-to-end: an LLMConfig with capability_overrides.vision = 'unsupported'
    should cause build_request_data to inline aux descriptions in serialized messages."""
    from letta.llm_api.openai_client import OpenAIClient
    from letta.schemas.llm_config import LLMConfig

    monkeypatch.setattr(
        "letta.llm_api.openai_client.describe_image",
        lambda url: "an auto-described image"
    )

    llm_config = LLMConfig(
        model="kimi-k2.6",
        model_endpoint_type="openai",
        model_endpoint="https://crof.ai/v1",
        context_window=131072,
        capability_overrides={"vision": "unsupported"},
    )

    pyd_user = _user_with_image("look at this")  # helper from earlier tasks
    pyd_assistant = Message(role=MessageRole.assistant, content=[TextContent(text="ok")])
    messages = [pyd_user, pyd_assistant]

    client = OpenAIClient()
    data = client.build_request_data(
        agent_type=None,
        messages=messages,
        llm_config=llm_config,
        tools=[],
    )

    user_dicts = [m for m in data.messages if m.role == "user"]
    body = user_dicts[0].content
    assert isinstance(body, str)
    assert "look at this" in body
    assert "<system-interrupt>" in body
    assert "an auto-described image" in body
    assert "image_url" not in body


def test_build_request_data_no_describer_when_vision_auto(monkeypatch):
    from letta.llm_api.openai_client import OpenAIClient
    from letta.schemas.llm_config import LLMConfig

    # If describe_image is called we'd raise; we want to confirm it isn't.
    monkeypatch.setattr(
        "letta.llm_api.openai_client.describe_image",
        lambda url: (_ for _ in ()).throw(AssertionError("describe_image must not be called when vision='auto'"))
    )

    llm_config = LLMConfig(
        model="gpt-4o",
        model_endpoint_type="openai",
        model_endpoint="https://api.openai.com/v1",
        context_window=131072,
        # No capability_overrides → vision == "auto"
    )

    pyd_user = _user_with_image("look at this")
    messages = [pyd_user]

    client = OpenAIClient()
    data = client.build_request_data(
        agent_type=None,
        messages=messages,
        llm_config=llm_config,
        tools=[],
    )
    # Multimodal content survives.
    assert any(
        isinstance(m.content, list) and any(getattr(p, "type", None) == "image_url" for p in m.content)
        for m in data.messages if m.role == "user"
    )
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
uv run pytest --noconftest tests/test_chat_completions_tool_return_images.py -k "build_request_data" -v
```

Expected: 2 fails — `image_describer` not propagated yet.

- [ ] **Step 3: Modify `OpenAIClient.build_request_data` in `letta/llm_api/openai_client.py`**

Find `build_request_data` (around line 543). Locate the two serialization calls (around lines 593–595 and 645).

Add an `image_describer` resolution near the top of the function body (before the `to_openai_dicts_from_list` call):

```python
        # Resolve auxiliary image describer for pre-call mode (vision = "unsupported")
        if llm_config.vision_capability() == "unsupported":
            from letta.llm_api.auxiliary_client import describe_image as _aux_describer
            image_describer = _aux_describer
        else:
            image_describer = None
```

Pass it to both calls:

```python
        openai_message_list = [
            cast_message_to_subtype(m)
            for m in PydanticMessage.to_openai_dicts_from_list(
                request_messages,
                put_inner_thoughts_in_kwargs=llm_config.put_inner_thoughts_in_kwargs,
                use_developer_message=use_developer_message,
                tool_return_truncation_chars=tool_return_truncation_chars,
                image_describer=image_describer,  # NEW
            )
        ]

        # ... later ...

        data = ChatCompletionRequest(
            model=model,
            messages=fill_image_content_in_messages(
                openai_message_list, messages, image_describer=image_describer
            ),
            ...
        )
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
uv run pytest --noconftest tests/test_chat_completions_tool_return_images.py -q
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add letta/llm_api/openai_client.py tests/test_chat_completions_tool_return_images.py
git commit -m "feat(openai_client): wire pre-call image_describer in build_request_data"
```

---

## Task 14: Manual end-to-end verification

**Files:**
- None (manual verification)

This is a smoke test the implementer runs against the real letta server on cypher to confirm the complete pipeline works against an actual agent + crof.ai endpoint. No tests to write.

- [ ] **Step 1: Build and deploy the new image on cypher**

```bash
ssh cypher@cypher
cd /home/cypher/letta-src
git fetch snowctl
git worktree add /tmp/letta-build snowctl/feat/auxiliary-image-support
cd /tmp/letta-build
docker build -t snowctl/letta:latest .
cd ~/Argos
docker compose up -d letta-server
sleep 30
docker compose ps letta-server
```

Expected: `Up 30 seconds (healthy)`.

- [ ] **Step 2: Verify the new code is in the running container**

```bash
ssh cypher@cypher 'docker exec argos-letta-server-1 grep -c "describe_image\|format_tool_image_envelope\|capability_overrides" /app/letta/llm_api/auxiliary_client.py /app/letta/schemas/llm_config.py'
```

Expected: non-zero counts in both files.

- [ ] **Step 3: Configure aux env vars**

```bash
ssh cypher@cypher 'echo "
LETTA_AUX_VISION_BASE_URL=https://crof.ai/v1
LETTA_AUX_VISION_MODEL=qwen3.6-27b
LETTA_AUX_VISION_API_KEY=\${OPENAI_API_KEY}
" >> ~/Argos/.env'
ssh cypher@cypher 'cd ~/Argos && docker compose up -d letta-server'
```

- [ ] **Step 4: Set the kimi+crof agent to vision=unsupported**

```bash
ssh cypher@cypher 'TOKEN=$(grep LETTA_SERVER_PASSWORD ~/Argos/.env | cut -d= -f2); curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '"'"'{"llm_config":{"capability_overrides":{"vision":"unsupported"}}}'"'"' http://127.0.0.1:8283/v1/agents/agent-97b245a8-9839-4d98-8907-6ddbfce40b06'
```

- [ ] **Step 5: Verify with a real image send**

Send an image to the kimi-k2.6 agent through whichever channel is convenient (matrix, PWA). Confirm:

1. The agent responds within ~5-10 seconds (one aux roundtrip + main call).
2. The response references the image content correctly (e.g. transcribes visible text).
3. Server logs contain the line `auxiliary_client: vision auxiliary disabled` is **NOT** present (config is loaded), and no `[OpenAI] vision-incapable 400` warnings (because we're pre-calling, not reactively retrying).

- [ ] **Step 6: Verify cache hit on second send**

Send the same image again. Confirm the response time is faster (~2-3s vs ~5-10s) — the aux call is cached.

- [ ] **Step 7: Clean up**

```bash
ssh cypher@cypher 'cd /home/cypher/letta-src && git worktree remove /tmp/letta-build'
```

---

## Task 15: Push and merge to snowctl/main

**Files:**
- None (git operations only)

- [ ] **Step 1: Push the feature branch**

```bash
cd /path/to/letta/.worktrees/aux-vision
git push -u snowctl feat/auxiliary-image-support
```

- [ ] **Step 2: Fast-forward merge to main**

```bash
cd /path/to/letta
git fetch snowctl
git merge-base --is-ancestor snowctl/main snowctl/feat/auxiliary-image-support && echo "FF-able"
git push snowctl snowctl/feat/auxiliary-image-support:main
```

Expected: `FF-able`, then a successful update from the previous main SHA to the new feature SHA.

- [ ] **Step 3: Confirm in the running container the merge advanced main**

```bash
ssh cypher@cypher 'cd /home/cypher/letta-src && git fetch snowctl main && git log snowctl/main --oneline -5'
```

Expected: the feature branch's commits appear on `snowctl/main`.

---

## Out of scope (do NOT implement)

These were explicitly deferred in the spec and should not be added by the implementer:

- Resolution chain across multiple aux providers (`_try_openrouter`, `_try_nous`, etc. patterns from Hermes)
- Credit-pool / 402-retry semantics
- Async-and-sync parallel client variants beyond what's needed (single sync `describe_image` + single async `describe_image_async` is enough)
- Caption-aware aux (passing the user's caption into the aux prompt)
- Per-agent aux override (env-vars are enough for v1)
- Per-task surface APIs beyond `describe_image` (no `summarize_text`, no `extract_url`)

If during implementation you find a need that one of these would solve, **stop and surface it** — those decisions belong in a follow-up spec, not in this plan.
