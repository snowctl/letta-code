// src/channels/matrix/messageActions.ts
import type { ChannelMessageActionAdapter } from "../pluginTypes";

export const matrixMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool() {
    return { actions: ["send", "react", "upload-file", "edit"] };
  },

  async handleAction(ctx) {
    const { request, route, adapter, formatText } = ctx;

    if (
      request.action !== "send" &&
      request.action !== "react" &&
      request.action !== "upload-file" &&
      request.action !== "edit"
    ) {
      return `Error: Action "${request.action}" is not supported on matrix.`;
    }

    if (request.action === "react") {
      if (!request.emoji?.trim() && !request.remove) {
        return "Error: Matrix react requires emoji.";
      }
      if (!request.messageId?.trim()) {
        return "Error: Matrix react requires messageId.";
      }
      const result = await adapter.sendMessage({
        channel: "matrix",
        accountId: route.accountId,
        chatId: request.chatId,
        text: "",
        targetMessageId: request.messageId,
        reaction: request.emoji,
        removeReaction: request.remove,
      });
      return request.remove
        ? `Reaction removed on matrix (message_id: ${result.messageId})`
        : `Reaction added on matrix (message_id: ${result.messageId})`;
    }

    if (request.action === "edit") {
      if (!request.messageId?.trim()) {
        return "Error: Matrix edit requires messageId (the message you sent earlier).";
      }
      if (!request.message?.trim()) {
        return "Error: Matrix edit requires message (the new body).";
      }
      const formatted = formatText(request.message);
      const result = await adapter.sendMessage({
        channel: "matrix",
        accountId: route.accountId,
        chatId: request.chatId,
        text: formatted.text,
        editTargetMessageId: request.messageId,
        parseMode: formatted.parseMode,
      });
      return `Message edited on matrix (message_id: ${result.messageId})`;
    }

    if (!request.message?.trim() && !request.mediaPath?.trim()) {
      return "Error: Matrix send requires message or media.";
    }
    if (request.action === "upload-file" && !request.mediaPath?.trim()) {
      return "Error: Matrix upload-file requires media.";
    }
    if (request.action === "send" && !request.message?.trim()) {
      return "Error: Matrix send requires message.";
    }

    const formatted = formatText(request.message ?? "");
    const result = await adapter.sendMessage({
      channel: "matrix",
      accountId: route.accountId,
      chatId: request.chatId,
      text: formatted.text,
      replyToMessageId: request.replyToMessageId,
      mediaPath: request.mediaPath,
      fileName: request.filename,
      title: request.title,
      parseMode: formatted.parseMode,
    });

    return request.mediaPath
      ? `Attachment sent to matrix (message_id: ${result.messageId})`
      : `Message sent to matrix (message_id: ${result.messageId})`;
  },
};
