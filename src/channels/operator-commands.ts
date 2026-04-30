import type { Letta } from "@letta-ai/letta-client";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { getAvailableModelHandles } from "../agent/available-models.js";
import {
  recompileAgentSystemPrompt,
  updateAgentLLMConfig,
} from "../agent/modify.js";

export interface OperatorCommandContext {
  agentId: string;
  chatId: string;
  client: Letta;
  commandPrefix: string;
  getCurrentConvId(): string;
  setCurrentConvId(id: string): Promise<void>;
  requestCancel(): boolean;
  getConvListCache(): Conversation[] | null;
  setConvListCache(list: Conversation[] | null): void;
}

type RecompileDeps = {
  recompile?: (conversationId: string, agentId: string) => Promise<string>;
};

export async function handleOperatorCommand(
  command: string,
  args: string[],
  ctx: OperatorCommandContext,
  deps: RecompileDeps = {},
): Promise<string> {
  try {
    switch (command) {
      case "cancel":
        return handleCancel(ctx);
      case "compact":
        return await handleCompact(ctx);
      case "recompile":
        return await handleRecompile(ctx, deps);
      case "conv":
        return await handleConv(args, ctx);
      case "reset":
        return await handleReset(args, ctx);
      case "models":
        return await handleModels(ctx);
      case "model":
        return await handleModelSwitch(args, ctx);
      case "ctx":
        return await handleContextWindow(args, ctx);
      case "help":
        return handleHelp(ctx);
      default:
        return `Unknown command: ${command}`;
    }
  } catch (err) {
    return `${command} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function handleHelp(ctx: OperatorCommandContext): string {
  const p = ctx.commandPrefix;
  const cmd = (name: string, desc: string) => `- \`${p}${name}\` — ${desc}`;
  return [
    "**Commands**",
    "",
    "**Model**",
    cmd("models", "list available models with context window sizes"),
    cmd("model <handle>", "switch the active model"),
    cmd("ctx <size>", "set context window size (e.g. 128K, 1M)"),
    "",
    "**Conversations**",
    cmd("conv list", "list conversations"),
    cmd("conv new", "start a new conversation"),
    cmd("conv fork", "fork the current conversation"),
    cmd("conv switch <n>", "switch to conversation n"),
    cmd("conv delete <n>", "delete conversation n"),
    cmd("reset", "wipe messages on the current conversation"),
    cmd("reset <n>", "wipe messages on conversation n (run conv list first)"),
    "",
    "**System**",
    cmd("compact", "force memory compaction"),
    cmd("recompile", "recompile system prompt"),
    cmd("cancel", "cancel the active run"),
    cmd("help", "show this message"),
  ].join("\n");
}

function handleCancel(ctx: OperatorCommandContext): string {
  const cancelled = ctx.requestCancel();
  return cancelled ? "Cancelled." : "No active run.";
}

async function handleCompact(ctx: OperatorCommandContext): Promise<string> {
  const convId = ctx.getCurrentConvId();
  if (convId === "default" || !convId) {
    await ctx.client.agents.messages.compact(ctx.agentId);
  } else {
    await ctx.client.conversations.messages.compact(convId);
  }
  return "Compaction triggered.";
}

async function handleRecompile(
  ctx: OperatorCommandContext,
  deps: RecompileDeps,
): Promise<string> {
  const convId = ctx.getCurrentConvId();
  if (convId === "default" || !convId) {
    await ctx.client.agents.recompile(ctx.agentId);
  } else {
    const recompile = deps.recompile ?? recompileAgentSystemPrompt;
    await recompile(convId, ctx.agentId);
  }
  return "System prompt recompiled.";
}

async function handleConv(
  args: string[],
  ctx: OperatorCommandContext,
): Promise<string> {
  const sub = args[0];
  switch (sub) {
    case "list":
      return await convList(ctx);
    case "new":
      return await convNew(ctx);
    case "fork":
      return await convFork(ctx);
    case "switch":
      return await convSwitch(args[1], ctx);
    case "delete":
      return await convDelete(args[1], ctx);
    default:
      return "Unknown sub-command. Options: `conv list`, `conv new`, `conv fork`, `conv switch <n>`, `conv delete <n>`.";
  }
}

async function convList(ctx: OperatorCommandContext): Promise<string> {
  const convs = await ctx.client.conversations.list({ agent_id: ctx.agentId });
  const currentId = ctx.getCurrentConvId();

  const syntheticDefault: Conversation = {
    id: "default",
    agent_id: ctx.agentId,
  } as Conversation;

  const ordered = [syntheticDefault, ...convs];
  ctx.setConvListCache(ordered);

  const lines = ordered.map((c, i) => {
    const label = c.id === "default" ? "default" : (c.summary ?? c.id);
    const isCurrent = c.id === currentId;
    return `${i + 1}. ${label}${isCurrent ? " (current)" : ""}`;
  });

  if (convs.length === 0) {
    lines.push(
      `No named conversations yet. Use ${ctx.commandPrefix}conv new to create one.`,
    );
  }

  return `Conversations:\n${lines.join("\n")}`;
}

async function convNew(ctx: OperatorCommandContext): Promise<string> {
  const conv = await ctx.client.conversations.create({ agent_id: ctx.agentId });
  await ctx.setCurrentConvId(conv.id);
  ctx.setConvListCache(null);
  return `New conversation started (ID: ${conv.id}).`;
}

async function convFork(ctx: OperatorCommandContext): Promise<string> {
  const convId = ctx.getCurrentConvId();
  if (convId === "default" || !convId) {
    return `Cannot fork the default conversation — use ${ctx.commandPrefix}conv new instead.`;
  }
  const forked = await ctx.client.conversations.fork(convId);
  await ctx.setCurrentConvId(forked.id);
  ctx.setConvListCache(null);
  return `Conversation forked (ID: ${forked.id}).`;
}

async function convSwitch(
  nStr: string | undefined,
  ctx: OperatorCommandContext,
): Promise<string> {
  const n = parseInt(nStr ?? "", 10);
  if (Number.isNaN(n) || n < 1) {
    return "Usage: `!conv switch <number>`";
  }
  if (n === 1) {
    await ctx.setCurrentConvId("default");
    return "Switched to: default.";
  }
  const cache = ctx.getConvListCache();
  if (!cache) {
    return "Run conv list first to see available conversations.";
  }
  const target = cache[n - 1];
  if (!target) {
    return `No conversation at position ${n}. Run conv list to see options.`;
  }
  await ctx.setCurrentConvId(target.id);
  const label =
    target.id === "default" ? "default" : (target.summary ?? target.id);
  return `Switched to: ${label}.`;
}

async function convDelete(
  nStr: string | undefined,
  ctx: OperatorCommandContext,
): Promise<string> {
  const n = parseInt(nStr ?? "", 10);
  if (Number.isNaN(n) || n < 1) {
    return "Usage: `!conv delete <number>`";
  }
  const cache = ctx.getConvListCache();
  if (!cache) {
    return "Run conv list first to see available conversations.";
  }
  const target = cache[n - 1];
  if (!target || target.id === "default") {
    return "Cannot delete that conversation.";
  }
  const currentId = ctx.getCurrentConvId();
  await ctx.client.conversations.delete(target.id);
  ctx.setConvListCache(null);
  if (currentId === target.id) {
    await ctx.setCurrentConvId("default");
    return "Deleted. Switched to default.";
  }
  return "Deleted.";
}

/**
 * Wipe messages on a conversation. With no args, targets the currently active
 * conversation. With a numeric arg, targets the conversation at that position
 * in the cached `conv list` (1 = default, 2+ = named).
 *
 * Default conversation (position 1): uses `agents.messages.reset` which clears
 * messages but keeps the conversation itself. Named conversations: letta-server
 * has no per-conversation messages-purge endpoint, so reset means soft-deleting
 * the named conversation; if it's the active one, switch back to default.
 */
async function handleReset(
  args: string[],
  ctx: OperatorCommandContext,
): Promise<string> {
  // Resolve the target conversation id (default or named).
  let targetId: string;
  let targetLabel: string;
  if (args.length === 0) {
    targetId = ctx.getCurrentConvId() || "default";
    targetLabel = targetId === "default" ? "default" : targetId;
  } else {
    const n = parseInt(args[0] ?? "", 10);
    if (Number.isNaN(n) || n < 1) {
      return "Usage: `!reset [number]` — omit number to reset current conversation";
    }
    if (n === 1) {
      targetId = "default";
      targetLabel = "default";
    } else {
      const cache = ctx.getConvListCache();
      if (!cache) {
        return "Run conv list first to see available conversations.";
      }
      const target = cache[n - 1];
      if (!target) {
        return `No conversation at position ${n}. Run conv list to see options.`;
      }
      targetId = target.id;
      targetLabel =
        target.id === "default" ? "default" : (target.summary ?? target.id);
    }
  }

  if (targetId === "default") {
    await ctx.client.agents.messages.reset(ctx.agentId, {
      add_default_initial_messages: false,
    });
    return "Reset default conversation. All messages cleared.";
  }

  // Named conversation: no purge-messages endpoint exists; soft-delete instead.
  const currentId = ctx.getCurrentConvId();
  await ctx.client.conversations.delete(targetId);
  ctx.setConvListCache(null);
  if (currentId === targetId) {
    await ctx.setCurrentConvId("default");
    return `Reset conversation "${targetLabel}" (deleted, switched to default).`;
  }
  return `Reset conversation "${targetLabel}" (deleted).`;
}

async function handleModels(ctx: OperatorCommandContext): Promise<string> {
  const [result, agent] = await Promise.all([
    getAvailableModelHandles({ forceRefresh: true }),
    ctx.client.agents.retrieve(ctx.agentId),
  ]);

  const activeModel = agent.model;
  const lines: string[] = ["**Models:**", ""];

  for (const handle of result.handles) {
    const ctx_k = result.contextWindows.get(handle);
    const ctxStr = ctx_k
      ? ctx_k >= 1_000_000
        ? ` — ${Math.round(ctx_k / 1_000_000)}M ctx`
        : ` — ${Math.round(ctx_k / 1000)}K ctx`
      : "";
    const active = handle === activeModel;
    lines.push(
      `- ${active ? "**" : ""}\`${handle}\`${active ? "**" : ""}${ctxStr}`,
    );
  }

  lines.push("");
  lines.push("Use `!model <handle>` to switch.");
  return lines.join("\n");
}

async function handleModelSwitch(
  args: string[],
  ctx: OperatorCommandContext,
): Promise<string> {
  if (args.length === 0) {
    return "Usage: `!model <provider/model-name>`";
  }

  const handle = args[0] as string;

  if (!handle.includes("/")) {
    return "Model handles must be in provider/model-name format (e.g. anthropic/claude-sonnet-4-6). Use !models to see available handles.";
  }

  const [available] = await Promise.all([getAvailableModelHandles()]);
  if (!available.handles.has(handle)) {
    return `Model '${handle}' is not available on this server. Use !models to see what's available.`;
  }

  await updateAgentLLMConfig(ctx.agentId, handle);
  return `Model switched to ${handle}.`;
}

function parseContextWindowSize(raw: string): number | null {
  const s = raw.trim().toUpperCase();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*([KM]?)$/);
  if (!match) return null;
  const n = parseFloat(match[1] as string);
  const suffix = match[2];
  if (suffix === "M") return Math.round(n * 1_000_000);
  if (suffix === "K") return Math.round(n * 1_000);
  return Math.round(n);
}

async function handleContextWindow(
  args: string[],
  ctx: OperatorCommandContext,
): Promise<string> {
  if (args.length === 0) {
    return "Usage: `!ctx <size>` — e.g. `!ctx 128K`, `!ctx 1M`, `!ctx 200000`";
  }

  const size = parseContextWindowSize(args[0] as string);
  if (!size || size < 1000) {
    return `Invalid size '${args[0]}'. Use a number with optional K/M suffix (e.g. 128K, 1M).`;
  }

  const agent = await ctx.client.agents.retrieve(ctx.agentId);
  const model = agent.model;
  if (!model) {
    return "Could not determine current model.";
  }

  await updateAgentLLMConfig(ctx.agentId, model, { context_window: size });

  const sizeLabel =
    size >= 1_000_000
      ? `${Math.round(size / 1_000_000)}M`
      : `${Math.round(size / 1_000)}K`;
  return `Context window set to ${sizeLabel} (${size.toLocaleString()} tokens).`;
}

// Exported for testing
export {
  handleModels,
  handleModelSwitch,
  handleHelp,
  handleContextWindow,
  parseContextWindowSize,
};
