import {
  isSupportedChannelId,
  loadChannelPlugin,
} from "../../channels/pluginRegistry";
import type { ChannelRegistry } from "../../channels/registry";
import { getChannelRegistry } from "../../channels/registry";
import { formatOutboundChannelMessage } from "./MessageChannel";

export type NotifyUserArgs = {
  channel: string;
  chat_id: string;
  thread_id?: string;
  message: string;
  parentScope?: { agentId: string; conversationId: string };
};

type NotifyUserDeps = {
  parentScope?: { agentId: string; conversationId: string };
  registry?: ChannelRegistry | null;
};

export async function notify_user(
  args: NotifyUserArgs,
  deps?: NotifyUserDeps,
): Promise<string> {
  const scope = deps?.parentScope ?? args.parentScope;
  if (!scope) {
    return "Error: NotifyUser requires execution scope (agentId + conversationId).";
  }

  const registry = deps?.registry ?? getChannelRegistry();
  if (!registry) {
    return "Error: Channel system is not initialized.";
  }

  const route = registry.getRouteForScope(
    args.channel,
    args.chat_id,
    scope.agentId,
    scope.conversationId,
  );
  if (!route) {
    return `Error: No route for chat_id "${args.chat_id}" on "${args.channel}" for this agent/conversation.`;
  }

  const adapter = registry.getAdapter(args.channel, route.accountId);
  if (!adapter?.isRunning()) {
    return `Error: Channel "${args.channel}" is not currently running.`;
  }

  if (!isSupportedChannelId(args.channel)) {
    return `Error: Unsupported channel "${args.channel}".`;
  }

  const plugin = await loadChannelPlugin(args.channel);
  if (!plugin.messageActions) {
    return `Error: Channel "${args.channel}" does not expose message actions.`;
  }

  try {
    return await plugin.messageActions.handleAction({
      request: {
        action: "send",
        channel: args.channel,
        chatId: args.chat_id,
        message: args.message,
        threadId: args.thread_id ?? null,
      },
      route,
      adapter,
      formatText: (t: string) => formatOutboundChannelMessage(args.channel, t),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return `Error sending notification to ${args.channel}: ${msg}`;
  }
}

export const NotifyUserSchema = {
  type: "object",
  properties: {
    channel: {
      type: "string",
      description: "Channel platform (e.g. telegram, matrix, slack).",
    },
    chat_id: {
      type: "string",
      description:
        "Target chat or room ID. Use one of the available targets listed in the task context.",
    },
    thread_id: {
      type: "string",
      description: "Optional thread ID to reply into.",
    },
    message: { type: "string", description: "Message text to send." },
  },
  required: ["channel", "chat_id", "message"],
};

export const NotifyUserDescription =
  `Send a message to a channel user. Use this tool during scheduled or background runs where your response text is not automatically delivered.\n\nSupply channel and chat_id from the available targets listed in the scheduled task context.`.trim();
