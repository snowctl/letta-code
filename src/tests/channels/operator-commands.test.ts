import { describe, expect, mock, test } from "bun:test";
import type { Letta } from "@letta-ai/letta-client";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import {
  handleOperatorCommand,
  type OperatorCommandContext,
} from "../../channels/operator-commands";

function makeCtx(
  overrides: Partial<OperatorCommandContext> = {},
): OperatorCommandContext {
  return {
    agentId: "agent-1",
    chatId: "chat-1",
    commandPrefix: "!",
    client: {
      agents: {
        messages: {
          compact: mock(async () => ({ status: "ok" })),
        },
      },
      conversations: {
        list: mock(async () => []),
        create: mock(
          async () => ({ id: "conv-new", agent_id: "agent-1" }) as Conversation,
        ),
        fork: mock(
          async () =>
            ({ id: "conv-fork", agent_id: "agent-1" }) as Conversation,
        ),
        delete: mock(async () => ({})),
        messages: {
          compact: mock(async () => ({ status: "ok" })),
        },
      },
    } as unknown as Letta,
    getCurrentConvId: () => "default",
    setCurrentConvId: mock(async () => {}),
    requestCancel: mock(() => true),
    getConvListCache: () => null,
    setConvListCache: mock((_list: Conversation[] | null) => {}),
    ...overrides,
  };
}

describe("handleOperatorCommand — cancel", () => {
  test("returns 'Cancelled.' when requestCancel returns true", async () => {
    const ctx = makeCtx({ requestCancel: mock(() => true) });
    expect(await handleOperatorCommand("cancel", [], ctx)).toBe("Cancelled.");
  });

  test("returns 'No active run.' when requestCancel returns false", async () => {
    const ctx = makeCtx({ requestCancel: mock(() => false) });
    expect(await handleOperatorCommand("cancel", [], ctx)).toBe(
      "No active run.",
    );
  });
});

describe("handleOperatorCommand — compact", () => {
  test("calls agents.messages.compact for default conversation", async () => {
    const ctx = makeCtx({ getCurrentConvId: () => "default" });
    const result = await handleOperatorCommand("compact", [], ctx);
    expect(result).toBe("Compaction triggered.");
    expect(ctx.client.agents.messages.compact).toHaveBeenCalledWith("agent-1");
  });

  test("calls conversations.messages.compact for named conversation", async () => {
    const ctx = makeCtx({ getCurrentConvId: () => "conv-abc" });
    const result = await handleOperatorCommand("compact", [], ctx);
    expect(result).toBe("Compaction triggered.");
    expect(ctx.client.conversations.messages.compact).toHaveBeenCalledWith(
      "conv-abc",
    );
  });
});

describe("handleOperatorCommand — recompile", () => {
  test("calls recompile and returns success message", async () => {
    const recompileMock = mock(async () => "ok");
    const ctx = makeCtx({ getCurrentConvId: () => "conv-abc" });
    const result = await handleOperatorCommand("recompile", [], ctx, {
      recompile: recompileMock,
    });
    expect(result).toBe("System prompt recompiled.");
    expect(recompileMock).toHaveBeenCalledWith("conv-abc", "agent-1");
  });
});

describe("handleOperatorCommand — conv list", () => {
  test("lists conversations with default first", async () => {
    const convs: Conversation[] = [
      {
        id: "conv-1",
        agent_id: "agent-1",
        summary: "Work session",
      } as Conversation,
    ];
    const ctx = makeCtx({
      getCurrentConvId: () => "default",
      client: {
        agents: { messages: { compact: mock(async () => ({})) } },
        conversations: {
          list: mock(async () => convs),
          create: mock(async () => ({}) as Conversation),
          fork: mock(async () => ({}) as Conversation),
          delete: mock(async () => ({})),
          messages: { compact: mock(async () => ({})) },
        },
      } as unknown as Letta,
    });
    const result = await handleOperatorCommand("conv", ["list"], ctx);
    expect(result).toContain("1. default (current)");
    expect(result).toContain("2. Work session");
    expect(ctx.setConvListCache).toHaveBeenCalled();
  });

  test("shows 'No named conversations' when list is empty", async () => {
    const ctx = makeCtx({
      getCurrentConvId: () => "default",
      client: {
        agents: { messages: { compact: mock(async () => ({})) } },
        conversations: {
          list: mock(async () => []),
          create: mock(async () => ({}) as Conversation),
          fork: mock(async () => ({}) as Conversation),
          delete: mock(async () => ({})),
          messages: { compact: mock(async () => ({})) },
        },
      } as unknown as Letta,
    });
    const result = await handleOperatorCommand("conv", ["list"], ctx);
    expect(result).toContain("1. default (current)");
    expect(result).toContain("No named conversations yet.");
  });
});

describe("handleOperatorCommand — conv new", () => {
  test("creates a new conversation and sets it current", async () => {
    const ctx = makeCtx();
    const result = await handleOperatorCommand("conv", ["new"], ctx);
    expect(result).toContain("New conversation started");
    expect(result).toContain("conv-new");
    expect(ctx.setCurrentConvId).toHaveBeenCalledWith("conv-new");
  });
});

describe("handleOperatorCommand — conv fork", () => {
  test("forks named conversation", async () => {
    const ctx = makeCtx({ getCurrentConvId: () => "conv-current" });
    const result = await handleOperatorCommand("conv", ["fork"], ctx);
    expect(result).toContain("Conversation forked");
    expect(result).toContain("conv-fork");
    expect(ctx.setCurrentConvId).toHaveBeenCalledWith("conv-fork");
  });

  test("refuses to fork default conversation", async () => {
    const ctx = makeCtx({ getCurrentConvId: () => "default" });
    const result = await handleOperatorCommand("conv", ["fork"], ctx);
    expect(result).toContain("Cannot fork the default");
  });
});

describe("handleOperatorCommand — conv switch", () => {
  test("requires list cache for n > 1", async () => {
    const ctx = makeCtx({ getConvListCache: () => null });
    const result = await handleOperatorCommand("conv", ["switch", "2"], ctx);
    expect(result).toContain("list first");
  });

  test("switches to position 1 (default) without cache", async () => {
    const ctx = makeCtx({ getConvListCache: () => null });
    const result = await handleOperatorCommand("conv", ["switch", "1"], ctx);
    expect(result).toContain("Switched to: default");
    expect(ctx.setCurrentConvId).toHaveBeenCalledWith("default");
  });

  test("switches to named conversation from cache", async () => {
    const cache: Conversation[] = [
      { id: "default", agent_id: "agent-1" } as Conversation,
      { id: "conv-work", agent_id: "agent-1", summary: "Work" } as Conversation,
    ];
    const ctx = makeCtx({ getConvListCache: () => cache });
    const result = await handleOperatorCommand("conv", ["switch", "2"], ctx);
    expect(result).toContain("Switched to: Work");
    expect(ctx.setCurrentConvId).toHaveBeenCalledWith("conv-work");
  });

  test("rejects out-of-range position", async () => {
    const cache: Conversation[] = [
      { id: "default", agent_id: "agent-1" } as Conversation,
    ];
    const ctx = makeCtx({ getConvListCache: () => cache });
    const result = await handleOperatorCommand("conv", ["switch", "5"], ctx);
    expect(result).toContain("No conversation at position 5");
  });
});

describe("handleOperatorCommand — conv delete", () => {
  test("requires list cache", async () => {
    const ctx = makeCtx({ getConvListCache: () => null });
    const result = await handleOperatorCommand("conv", ["delete", "2"], ctx);
    expect(result).toContain("list first");
  });

  test("refuses to delete default (position 1)", async () => {
    const cache: Conversation[] = [
      { id: "default", agent_id: "agent-1" } as Conversation,
    ];
    const ctx = makeCtx({ getConvListCache: () => cache });
    const result = await handleOperatorCommand("conv", ["delete", "1"], ctx);
    expect(result).toContain("Cannot delete");
  });

  test("deletes named conversation and reverts to default if it was current", async () => {
    const cache: Conversation[] = [
      { id: "default", agent_id: "agent-1" } as Conversation,
      { id: "conv-work", agent_id: "agent-1", summary: "Work" } as Conversation,
    ];
    const ctx = makeCtx({
      getCurrentConvId: () => "conv-work",
      getConvListCache: () => cache,
    });
    const result = await handleOperatorCommand("conv", ["delete", "2"], ctx);
    expect(result).toContain("Deleted. Switched to default.");
    expect(ctx.setCurrentConvId).toHaveBeenCalledWith("default");
  });

  test("deletes non-current conversation without changing current", async () => {
    const cache: Conversation[] = [
      { id: "default", agent_id: "agent-1" } as Conversation,
      { id: "conv-work", agent_id: "agent-1", summary: "Work" } as Conversation,
    ];
    const ctx = makeCtx({
      getCurrentConvId: () => "default",
      getConvListCache: () => cache,
    });
    const result = await handleOperatorCommand("conv", ["delete", "2"], ctx);
    expect(result).toBe("Deleted.");
    expect(ctx.setCurrentConvId).not.toHaveBeenCalled();
  });
});

describe("handleOperatorCommand — cache invalidation", () => {
  test("conv new clears the list cache", async () => {
    const ctx = makeCtx();
    await handleOperatorCommand("conv", ["new"], ctx);
    expect(ctx.setConvListCache).toHaveBeenLastCalledWith(null);
  });

  test("conv fork clears the list cache", async () => {
    const ctx = makeCtx({ getCurrentConvId: () => "conv-current" });
    await handleOperatorCommand("conv", ["fork"], ctx);
    expect(ctx.setConvListCache).toHaveBeenLastCalledWith(null);
  });

  test("conv delete clears the list cache", async () => {
    const cache = [
      { id: "default", agent_id: "agent-1" } as Conversation,
      { id: "conv-work", agent_id: "agent-1", summary: "Work" } as Conversation,
    ];
    const ctx = makeCtx({
      getCurrentConvId: () => "default",
      getConvListCache: () => cache,
    });
    await handleOperatorCommand("conv", ["delete", "2"], ctx);
    expect(ctx.setConvListCache).toHaveBeenLastCalledWith(null);
  });
});

describe("handleOperatorCommand — error handling", () => {
  test("wraps errors with command prefix", async () => {
    const ctx = makeCtx({
      requestCancel: mock(() => {
        throw new Error("boom");
      }),
    });
    const result = await handleOperatorCommand("cancel", [], ctx);
    expect(result).toBe("cancel failed: boom");
  });

  test("returns unknown command message for unrecognized command", async () => {
    const ctx = makeCtx();
    const result = await handleOperatorCommand("nope", [], ctx);
    expect(result).toContain("Unknown command");
  });
});
