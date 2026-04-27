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
    const handles = new Set(["anthropic/claude-sonnet-4-6", "openai/gpt-4o"]);

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
