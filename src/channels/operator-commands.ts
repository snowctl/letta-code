import type { Letta } from "@letta-ai/letta-client";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { recompileAgentSystemPrompt } from "../agent/modify.js";

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
  return [
    `${p}cancel — cancel the active run`,
    `${p}compact — force memory compaction`,
    `${p}recompile — recompile system prompt`,
    `${p}conv list — list conversations`,
    `${p}conv new — start a new conversation`,
    `${p}conv fork — fork the current conversation`,
    `${p}conv switch <n> — switch to conversation <n>`,
    `${p}conv delete <n> — delete conversation <n>`,
    `${p}help — show this message`,
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
      return "Unknown conv sub-command. Options: list, new, fork, switch <n>, delete <n>.";
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
    return "Usage: conv switch <number>";
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
    return "Usage: conv delete <number>";
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
