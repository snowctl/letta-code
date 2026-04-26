import { loadChannelPlugin } from "../../channels/pluginRegistry";
import type { ChannelRegistry } from "../../channels/registry";
import { getChannelRegistry } from "../../channels/registry";
import { formatOutboundChannelMessage } from "./MessageChannel";

export type ChannelActionArgs = {
  action: "react" | "edit" | "thread-reply" | "upload-file";
  // react
  emoji?: string;
  remove?: boolean;
  // edit
  text?: string;
  // thread-reply
  thread_id?: string;
  message?: string;
  // upload-file
  file_path?: string;
  url?: string;
  caption?: string;
  // injected by manager.ts
  parentScope?: { agentId: string; conversationId: string };
};

type ChannelActionDeps = {
  parentScope?: { agentId: string; conversationId: string };
  registry?: ChannelRegistry | null;
};

export async function channel_action(
  args: ChannelActionArgs,
  deps?: ChannelActionDeps,
): Promise<string> {
  const scope = deps?.parentScope ?? args.parentScope;
  if (!scope) {
    return "Error: ChannelAction requires execution scope (agentId + conversationId).";
  }

  const registry = deps?.registry ?? getChannelRegistry();
  if (!registry) {
    return "Error: Channel system is not initialized.";
  }

  const context = registry.getActiveTurnContext(scope.conversationId);
  if (!context) {
    return "Error: No active turn context for this conversation. ChannelAction can only be used during an inbound channel turn.";
  }

  const { channel, chatId, threadId, messageId, accountId } = context;

  const route = registry.getRouteForScope(
    channel,
    chatId,
    scope.agentId,
    scope.conversationId,
  );
  if (!route) {
    return `Error: No route for chat_id "${chatId}" on "${channel}" for this agent/conversation.`;
  }

  const adapter = registry.getAdapter(channel, accountId);
  if (!adapter?.isRunning()) {
    return `Error: Channel "${channel}" is not currently running.`;
  }

  const plugin = await loadChannelPlugin(channel);
  if (!plugin.messageActions) {
    return `Error: Channel "${channel}" does not expose message actions.`;
  }

  if (args.action === "react") {
    if (!args.emoji) return "Error: react requires emoji.";
    return await plugin.messageActions.handleAction({
      request: {
        action: "react",
        channel,
        chatId,
        messageId: messageId ?? "",
        emoji: args.emoji,
        remove: args.remove ?? false,
        threadId: threadId ?? null,
      },
      route,
      adapter,
      formatText: (t: string) => formatOutboundChannelMessage(channel, t),
    });
  }

  if (args.action === "edit") {
    const targetMessageId = registry.getLastSentMessageId(
      channel,
      accountId,
      scope.conversationId,
    );
    if (!targetMessageId) {
      return "Error: No previous message to edit in this conversation.";
    }
    if (!args.text) return "Error: edit requires text.";
    return await plugin.messageActions.handleAction({
      request: {
        action: "edit",
        channel,
        chatId,
        messageId: targetMessageId,
        message: args.text,
        threadId: threadId ?? null,
      },
      route,
      adapter,
      formatText: (t: string) => formatOutboundChannelMessage(channel, t),
    });
  }

  if (args.action === "thread-reply") {
    if (!args.message) return "Error: thread-reply requires message.";
    return await plugin.messageActions.handleAction({
      request: {
        action: "send",
        channel,
        chatId,
        message: args.message,
        threadId: args.thread_id ?? threadId ?? null,
      },
      route,
      adapter,
      formatText: (t: string) => formatOutboundChannelMessage(channel, t),
    });
  }

  if (args.action === "upload-file") {
    const mediaPath = args.file_path ?? args.url;
    if (!mediaPath) return "Error: upload-file requires file_path or url.";
    return await plugin.messageActions.handleAction({
      request: {
        action: "upload-file",
        channel,
        chatId,
        mediaPath,
        title: args.caption,
        threadId: threadId ?? null,
      },
      route,
      adapter,
      formatText: (t: string) => formatOutboundChannelMessage(channel, t),
    });
  }

  return `Error: Unknown action "${args.action}".`;
}

export const ChannelActionSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["react", "edit", "thread-reply", "upload-file"],
      description: "The side-effect action to perform on the channel.",
    },
    emoji: { type: "string", description: "Emoji for react action." },
    remove: { type: "boolean", description: "If true, removes the reaction." },
    text: { type: "string", description: "New text for edit action." },
    thread_id: {
      type: "string",
      description:
        "Thread ID override for thread-reply (defaults to inbound thread).",
    },
    message: { type: "string", description: "Message text for thread-reply." },
    file_path: {
      type: "string",
      description: "Local file path for upload-file.",
    },
    url: { type: "string", description: "URL for upload-file." },
    caption: { type: "string", description: "Caption for upload-file." },
  },
  required: ["action"],
};

export const ChannelActionDescription =
  `Perform a channel side-effect during an inbound channel turn. Your reply text is delivered automatically — use ChannelAction only for:
- react: add or remove a reaction on the inbound message
- edit: edit your most recently sent message in this conversation
- thread-reply: send a message into a specific thread (defaults to inbound thread)
- upload-file: send a file or media to the channel

Channel and chat context are resolved automatically from the inbound turn.`.trim();
