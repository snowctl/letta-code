import { beforeEach, describe, expect, it, vi } from "bun:test";

vi.mock("../agent/available-models.js", () => ({
  getAvailableModelHandles: vi.fn(),
}));

vi.mock("../agent/modify.js", () => ({
  updateAgentLLMConfig: vi.fn(),
}));

import { getAvailableModelHandles } from "../agent/available-models.js";
import { updateAgentLLMConfig } from "../agent/modify.js";
import type { OperatorCommandContext } from "./operator-commands.js";
import {
  handleContextWindow,
  handleHelp,
  handleModelSwitch,
  handleModels,
  parseContextWindowSize,
} from "./operator-commands.js";

function makeMockContext(
  overrides: Partial<OperatorCommandContext> = {},
): OperatorCommandContext {
  return {
    agentId: "agent-test-123",
    chatId: "!room:example.org",
    client: {
      agents: {
        retrieve: vi
          .fn()
          .mockResolvedValue({ model: "anthropic/claude-sonnet-4-6" }),
      },
    } as any,
    commandPrefix: "!",
    getCurrentConvId: vi.fn().mockReturnValue("default"),
    setCurrentConvId: vi.fn().mockResolvedValue(undefined),
    requestCancel: vi.fn().mockReturnValue(false),
    getConvListCache: vi.fn().mockReturnValue(null),
    setConvListCache: vi.fn(),
    ...overrides,
  };
}

function mockResult(
  handles: string[],
  ctxWindows: Record<string, number> = {},
) {
  return {
    handles: new Set(handles),
    contextWindows: new Map(Object.entries(ctxWindows)),
    source: "cache" as const,
    fetchedAt: Date.now(),
  };
}

describe("handleModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should list models with the active one bolded", async () => {
    (getAvailableModelHandles as any).mockResolvedValue(
      mockResult([
        "letta/auto",
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-opus-4-7",
      ]),
    );

    const ctx = makeMockContext();
    const result = await handleModels(ctx);

    expect(result).toContain("Models:");
    expect(result).toContain("**`anthropic/claude-sonnet-4-6`**");
    expect(result).toContain("`letta/auto`");
    expect(result).toContain("`anthropic/claude-opus-4-7`");
    expect(result).toContain("Use `!model <handle>` to switch.");
  });

  it("should bold only the active model", async () => {
    (getAvailableModelHandles as any).mockResolvedValue(
      mockResult(["letta/auto", "anthropic/claude-sonnet-4-6"]),
    );

    const ctx = makeMockContext({
      client: {
        agents: {
          retrieve: vi.fn().mockResolvedValue({ model: "letta/auto" }),
        },
      } as any,
    });

    const result = await handleModels(ctx);
    expect(result).toContain("**`letta/auto`**");
    expect(result).not.toContain("**`anthropic/claude-sonnet-4-6`**");
  });

  it("should handle a single-model server", async () => {
    (getAvailableModelHandles as any).mockResolvedValue(
      mockResult(["anthropic/claude-sonnet-4-6"]),
    );

    const ctx = makeMockContext();
    const result = await handleModels(ctx);
    expect(result).toContain("**`anthropic/claude-sonnet-4-6`**");
  });

  it("should fetch handles and agent in parallel", async () => {
    (getAvailableModelHandles as any).mockResolvedValue(
      mockResult(["letta/auto"]),
    );

    const retrieve = vi.fn().mockResolvedValue({ model: "letta/auto" });
    const ctx = makeMockContext({
      client: {
        agents: { retrieve },
      } as any,
    });

    await handleModels(ctx);
    expect(getAvailableModelHandles).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith("agent-test-123");
  });

  it("should propagate errors", async () => {
    (getAvailableModelHandles as any).mockRejectedValue(
      new Error("Server unreachable"),
    );

    const ctx = makeMockContext();
    await expect(handleModels(ctx)).rejects.toThrow("Server unreachable");
  });
});

describe("handleModelSwitch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return usage when no args provided", async () => {
    const ctx = makeMockContext();
    const result = await handleModelSwitch([], ctx);
    expect(result).toBe("Usage: !model <provider/model-name>");
  });

  it("should return format error for handles without /", async () => {
    const ctx = makeMockContext();
    const result = await handleModelSwitch(["sonnet"], ctx);
    expect(result).toContain("provider/model-name format");
    expect(result).toContain("anthropic/claude-sonnet-4-6");
  });

  it("should return not-available error for unknown models", async () => {
    (getAvailableModelHandles as any).mockResolvedValue(
      mockResult(["anthropic/claude-sonnet-4-6"]),
    );

    const ctx = makeMockContext();
    const result = await handleModelSwitch(["anthropic/fake"], ctx);
    expect(result).toContain("not available");
    expect(result).toContain("anthropic/fake");
  });

  it("should always switch the agent model regardless of active conversation", async () => {
    (getAvailableModelHandles as any).mockResolvedValue(
      mockResult(["anthropic/claude-sonnet-4-6"]),
    );

    for (const convId of ["default", "conv-abc", ""]) {
      vi.clearAllMocks();
      const ctx = makeMockContext({
        getCurrentConvId: vi.fn().mockReturnValue(convId),
      });
      const result = await handleModelSwitch(
        ["anthropic/claude-sonnet-4-6"],
        ctx,
      );

      expect(updateAgentLLMConfig).toHaveBeenCalledWith(
        "agent-test-123",
        "anthropic/claude-sonnet-4-6",
      );
      expect(result).toBe("Model switched to anthropic/claude-sonnet-4-6.");
    }
  });
});

describe("handleHelp", () => {
  it("should include !models and !model in help output", async () => {
    const ctx = makeMockContext();
    const result = await handleHelp(ctx);
    expect(result).toContain("!models");
    expect(result).toContain("!model");
  });

  it("should include !ctx in help output", async () => {
    const ctx = makeMockContext();
    const result = await handleHelp(ctx);
    expect(result).toContain("!ctx");
  });
});

describe("parseContextWindowSize", () => {
  it("parses plain numbers", () => {
    expect(parseContextWindowSize("200000")).toBe(200000);
  });

  it("parses K suffix case-insensitively", () => {
    expect(parseContextWindowSize("128K")).toBe(128000);
    expect(parseContextWindowSize("128k")).toBe(128000);
  });

  it("parses M suffix", () => {
    expect(parseContextWindowSize("1M")).toBe(1000000);
    expect(parseContextWindowSize("1.5M")).toBe(1500000);
  });

  it("returns null for invalid input", () => {
    expect(parseContextWindowSize("abc")).toBeNull();
    expect(parseContextWindowSize("")).toBeNull();
  });
});

describe("handleContextWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns usage when no args provided", async () => {
    const ctx = makeMockContext();
    const result = await handleContextWindow([], ctx);
    expect(result).toContain("Usage");
  });

  it("returns error for invalid size", async () => {
    const ctx = makeMockContext();
    const result = await handleContextWindow(["abc"], ctx);
    expect(result).toContain("Invalid size");
  });

  it("returns error for size below minimum", async () => {
    const ctx = makeMockContext();
    const result = await handleContextWindow(["500"], ctx);
    expect(result).toContain("Invalid size");
  });

  it("always updates agent LLM config regardless of active conversation", async () => {
    const ctx = makeMockContext({
      getCurrentConvId: vi.fn().mockReturnValue("conv-abc"),
    });
    const result = await handleContextWindow(["128K"], ctx);

    expect(updateAgentLLMConfig).toHaveBeenCalledWith(
      "agent-test-123",
      "anthropic/claude-sonnet-4-6",
      { context_window: 128000 },
    );
    expect(result).toContain("128K");
    expect(result).toContain("128,000");
  });

  it("formats 1M correctly", async () => {
    const ctx = makeMockContext();
    const result = await handleContextWindow(["1M"], ctx);
    expect(result).toContain("1M");
    expect(result).toContain("1,000,000");
  });
});
