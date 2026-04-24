/**
 * Telegram channel adapter using grammY.
 *
 * Uses long-polling (no webhook setup needed).
 */

import type { ReactionType, ReactionTypeEmoji } from "@grammyjs/types";
import type { Bot as GrammYBot, Context as GrammYContext } from "grammy";
import { formatChannelControlRequestPrompt } from "../interactive";
import {
  renderToolBlock,
  type ToolCallGroup,
  upsertToolCallGroup,
} from "../tool-block";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  InboundChannelMessage,
  OutboundChannelMessage,
  TelegramChannelAccount,
} from "../types";
import {
  detectTelegramUploadMethod,
  extractTelegramMessageText,
  getTelegramSenderName,
  resolveTelegramInboundAttachments,
  TELEGRAM_MEDIA_GROUP_FLUSH_MS,
  type TelegramLikeMessage,
} from "./media";
import { loadGrammyModule } from "./runtime";

type TelegramBot = GrammYBot<GrammYContext>;
type GrammYModule = typeof import("grammy") & {
  default?: Partial<typeof import("grammy")>;
};
type TelegramBotConstructor = typeof import("grammy").Bot;
type TelegramInputFileConstructor = typeof import("grammy").InputFile;
type BufferedMediaGroup = {
  messages: TelegramLikeMessage[];
  timer: ReturnType<typeof setTimeout>;
};
type TelegramReactionType =
  | {
      type?: "emoji";
      emoji?: string;
    }
  | {
      type?: "custom_emoji";
      custom_emoji_id?: string;
    }
  | {
      type?: "paid";
    };
type TelegramReactionUpdate = {
  chat: {
    id: string | number;
    type?: string;
    title?: string;
    username?: string;
  };
  message_id: string | number;
  user?: {
    id: string | number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  actor_chat?: {
    id: string | number;
    username?: string;
    title?: string;
  };
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
};

type TelegramCallbackQueryContext = {
  callbackQuery?: {
    id: string;
    data?: string;
    from: {
      id: string | number;
      username?: string;
      first_name?: string;
    };
    message?: {
      chat: { id: string | number; type?: string };
      message_id: number;
    };
  };
};

function resolveTelegramBotConstructor(
  mod: GrammYModule,
): TelegramBotConstructor {
  const Bot = mod.Bot ?? mod.default?.Bot;
  if (!Bot) {
    throw new Error('Installed Telegram runtime did not export "Bot".');
  }
  return Bot as TelegramBotConstructor;
}

function resolveTelegramInputFileConstructor(
  mod: GrammYModule,
): TelegramInputFileConstructor {
  const InputFile = mod.InputFile ?? mod.default?.InputFile;
  if (!InputFile) {
    throw new Error('Installed Telegram runtime did not export "InputFile".');
  }
  return InputFile as TelegramInputFileConstructor;
}

function buildTelegramReplyOptions(
  msg: Pick<
    OutboundChannelMessage,
    "replyToMessageId" | "parseMode" | "text" | "title"
  >,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (msg.replyToMessageId) {
    options.reply_parameters = {
      message_id: Number(msg.replyToMessageId),
    };
  }
  if (msg.text.trim().length > 0) {
    options.caption = msg.text;
    if (msg.parseMode) {
      options.parse_mode = msg.parseMode;
    }
  }
  if (msg.title?.trim()) {
    options.title = msg.title.trim();
  }
  return options;
}

function getTelegramReactionToken(
  reaction: TelegramReactionType,
): string | null {
  switch (reaction.type) {
    case "emoji":
      return reaction.emoji?.trim() || null;
    case "custom_emoji":
      return reaction.custom_emoji_id?.trim()
        ? `custom_emoji:${reaction.custom_emoji_id.trim()}`
        : null;
    case "paid":
      return "paid";
    default:
      return null;
  }
}

function parseTelegramReactionInput(reaction: string): ReactionType | null {
  const trimmed = reaction.trim();
  if (!trimmed) {
    return null;
  }

  const customEmojiPrefix = "custom_emoji:";
  if (trimmed.startsWith(customEmojiPrefix)) {
    const customEmojiId = trimmed.slice(customEmojiPrefix.length).trim();
    if (!customEmojiId) {
      return null;
    }
    return {
      type: "custom_emoji",
      custom_emoji_id: customEmojiId,
    };
  }

  return {
    type: "emoji",
    emoji: trimmed as ReactionTypeEmoji["emoji"],
  };
}

function getTelegramReactionSenderName(
  update: TelegramReactionUpdate,
): string | undefined {
  if (update.user) {
    return getTelegramSenderName({
      from: update.user,
    } as TelegramLikeMessage);
  }

  if (update.actor_chat?.username?.trim()) {
    return update.actor_chat.username.trim();
  }

  if (update.actor_chat?.title?.trim()) {
    return update.actor_chat.title.trim();
  }

  return undefined;
}

function getTelegramReactionSenderId(
  update: TelegramReactionUpdate,
): string | null {
  if (update.user?.id !== undefined) {
    return String(update.user.id);
  }
  if (update.actor_chat?.id !== undefined) {
    return String(update.actor_chat.id);
  }
  return null;
}

function getTelegramChatType(chat: { type?: string }): "direct" | "channel" {
  return chat.type === "private" ? "direct" : "channel";
}

export function createTelegramAdapter(
  config: TelegramChannelAccount,
): ChannelAdapter {
  let bot: TelegramBot | null = null;
  let botModule: GrammYModule | null = null;
  let running = false;
  const typingIntervalByChatId = new Map<
    string,
    ReturnType<typeof setInterval>
  >();

  interface ToolBlockState {
    messageId: number;
    groups: ToolCallGroup[];
  }
  const toolBlockStateByChatId = new Map<string, ToolBlockState>();
  const toolBlockOperationByChatId = new Map<string, Promise<void>>();

  const bufferedMediaGroups = new Map<string, BufferedMediaGroup>();
  let callbackKeyCounter = 0;
  const buttonMessages = new Map<
    string,
    { chatId: string; messageId: string; requestId: string; options: string[] }
  >();
  const awaitingFeedback = new Map<
    string,
    { requestId: string; action: "deny_reason" | "freeform"; buttonKey: string }
  >();
  const pendingReasoningByChatId = new Map<string, string>();
  const reasoningByKey = new Map<string, string>();

  function startTypingInterval(chatId: string): void {
    if (typingIntervalByChatId.has(chatId) || !bot) return;
    const fire = () => {
      if (!bot) return;
      void bot.api.sendChatAction(chatId, "typing").catch(() => {});
    };
    fire();
    typingIntervalByChatId.set(chatId, setInterval(fire, 4000));
  }

  function stopTypingInterval(chatId: string): void {
    const timer = typingIntervalByChatId.get(chatId);
    if (timer !== undefined) {
      clearInterval(timer);
      typingIntervalByChatId.delete(chatId);
    }
  }

  function scheduleToolBlockUpdate(
    chatId: string,
    toolName: string,
    description?: string,
  ): void {
    const previous =
      toolBlockOperationByChatId.get(chatId) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        if (!bot) return;
        const state = toolBlockStateByChatId.get(chatId);
        const newGroups = upsertToolCallGroup(
          state?.groups ?? [],
          toolName,
          description,
        );
        const text = renderToolBlock(newGroups);

        if (!state) {
          const result = await bot.api.sendMessage(chatId, text);
          toolBlockStateByChatId.set(chatId, {
            messageId: result.message_id,
            groups: newGroups,
          });
        } else if (text.length > 3800) {
          const freshGroups = upsertToolCallGroup([], toolName, description);
          const freshText = renderToolBlock(freshGroups);
          const result = await bot.api.sendMessage(chatId, freshText);
          toolBlockStateByChatId.set(chatId, {
            messageId: result.message_id,
            groups: freshGroups,
          });
        } else {
          await bot.api
            .editMessageText(chatId, state.messageId, text)
            .catch(() => {});
          toolBlockStateByChatId.set(chatId, { ...state, groups: newGroups });
        }
      })
      .catch((error) => {
        console.warn(
          `[Telegram] Failed to update tool block for ${chatId}:`,
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        if (toolBlockOperationByChatId.get(chatId) === operation) {
          toolBlockOperationByChatId.delete(chatId);
        }
      });
    toolBlockOperationByChatId.set(chatId, operation);
  }

  async function ensureModule(): Promise<GrammYModule> {
    if (!botModule) {
      botModule = await loadGrammyModule();
    }
    return botModule;
  }

  async function emitInboundMessages(
    telegramBot: TelegramBot,
    messages: TelegramLikeMessage[],
  ): Promise<void> {
    if (!adapter.onMessage) {
      return;
    }

    const primaryMessage =
      messages.find((message) => extractTelegramMessageText(message).trim()) ??
      messages[0];
    if (!primaryMessage?.from) {
      return;
    }

    const text = extractTelegramMessageText(primaryMessage);
    const attachments = await resolveTelegramInboundAttachments({
      accountId: config.accountId,
      token: config.token,
      bot: telegramBot,
      messages,
      transcribeVoice: config.transcribeVoice,
    });

    if (text.length === 0 && attachments.length === 0) {
      return;
    }

    const inbound: InboundChannelMessage = {
      channel: "telegram",
      accountId: config.accountId,
      chatId: String(primaryMessage.chat.id),
      senderId: String(primaryMessage.from.id),
      senderName: getTelegramSenderName(primaryMessage),
      text,
      timestamp: primaryMessage.date * 1000,
      messageId: String(primaryMessage.message_id),
      chatType: "direct",
      attachments: attachments.length > 0 ? attachments : undefined,
      raw: messages.length === 1 ? primaryMessage : messages,
    };

    try {
      await adapter.onMessage(inbound);
    } catch (error) {
      console.error("[Telegram] Error handling inbound message:", error);
    }
  }

  function scheduleBufferedMediaGroupFlush(
    telegramBot: TelegramBot,
    mediaGroupId: string,
  ): void {
    const entry = bufferedMediaGroups.get(mediaGroupId);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const buffered = bufferedMediaGroups.get(mediaGroupId);
      if (!buffered) {
        return;
      }
      bufferedMediaGroups.delete(mediaGroupId);
      void emitInboundMessages(telegramBot, buffered.messages);
    }, TELEGRAM_MEDIA_GROUP_FLUSH_MS);
  }

  async function ensureBot(): Promise<TelegramBot> {
    if (bot) {
      return bot;
    }

    const grammy = await ensureModule();
    const Bot = resolveTelegramBotConstructor(grammy);
    const instance = new Bot(config.token);

    instance.catch((error) => {
      const updateId = error.ctx?.update?.update_id;
      const prefix =
        updateId === undefined
          ? "[Telegram] Unhandled bot error:"
          : `[Telegram] Unhandled bot error for update ${updateId}:`;
      console.error(prefix, error.error);
    });

    instance.on("message", async (ctx) => {
      const msg = ctx.message as TelegramLikeMessage | undefined;
      if (!msg?.from) {
        return;
      }

      const chatId = String(msg.chat.id);
      const feedbackEntry = awaitingFeedback.get(chatId);
      if (feedbackEntry) {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        if (!text) {
          await instance.api.sendMessage(
            chatId,
            "Please type a non-empty reply.",
            {},
          );
          return;
        }

        awaitingFeedback.delete(chatId);

        const inbound: InboundChannelMessage = {
          channel: "telegram",
          accountId: config.accountId,
          chatId,
          senderId: String(msg.from.id),
          senderName: getTelegramSenderName(msg),
          text,
          timestamp: msg.date * 1000,
          messageId: String(msg.message_id),
          chatType: "direct",
        };

        if (adapter.onMessage) {
          try {
            await adapter.onMessage(inbound);
          } catch (error) {
            console.error("[Telegram] Error handling feedback message:", error);
          }
        }

        const buttonEntry = buttonMessages.get(feedbackEntry.buttonKey);
        if (buttonEntry) {
          buttonMessages.delete(feedbackEntry.buttonKey);
          const confirmationText =
            feedbackEntry.action === "deny_reason"
              ? `❌ Denied: ${text}`
              : `Selected: ${text}`;
          try {
            await instance.api.editMessageText(
              chatId,
              Number(buttonEntry.messageId),
              confirmationText,
            );
          } catch {
            await instance.api.sendMessage(chatId, confirmationText, {});
          }
        }

        return;
      }

      const mediaGroupId =
        typeof msg.media_group_id === "string" ? msg.media_group_id : null;
      if (mediaGroupId) {
        const existing = bufferedMediaGroups.get(mediaGroupId);
        if (existing) {
          existing.messages.push(msg);
        } else {
          bufferedMediaGroups.set(mediaGroupId, {
            messages: [msg],
            timer: setTimeout(() => undefined, TELEGRAM_MEDIA_GROUP_FLUSH_MS),
          });
        }
        scheduleBufferedMediaGroupFlush(instance, mediaGroupId);
        return;
      }

      await emitInboundMessages(instance, [msg]);
    });

    instance.on("message_reaction", async (ctx) => {
      if (!adapter.onMessage) {
        return;
      }

      const update = ctx.messageReaction as TelegramReactionUpdate | undefined;
      if (!update) {
        return;
      }

      const senderId = getTelegramReactionSenderId(update);
      if (!senderId) {
        return;
      }

      const oldTokens = new Set(
        update.old_reaction
          .map((reaction) => getTelegramReactionToken(reaction))
          .filter((value): value is string => typeof value === "string"),
      );
      const newTokens = new Set(
        update.new_reaction
          .map((reaction) => getTelegramReactionToken(reaction))
          .filter((value): value is string => typeof value === "string"),
      );

      const events: Array<{ action: "added" | "removed"; emoji: string }> = [];

      for (const emoji of oldTokens) {
        if (!newTokens.has(emoji)) {
          events.push({ action: "removed", emoji });
        }
      }

      for (const emoji of newTokens) {
        if (!oldTokens.has(emoji)) {
          events.push({ action: "added", emoji });
        }
      }

      for (const event of events) {
        try {
          await adapter.onMessage({
            channel: "telegram",
            accountId: config.accountId,
            chatId: String(update.chat.id),
            senderId,
            senderName: getTelegramReactionSenderName(update),
            text: `Telegram reaction ${event.action}: ${event.emoji}`,
            timestamp: update.date * 1000,
            messageId: String(update.message_id),
            chatType: getTelegramChatType(update.chat),
            reaction: {
              action: event.action,
              emoji: event.emoji,
              targetMessageId: String(update.message_id),
            },
            raw: update,
          });
        } catch (error) {
          console.error("[Telegram] Error handling reaction update:", error);
        }
      }
    });

    instance.on("callback_query", async (ctx) => {
      const query = (ctx as TelegramCallbackQueryContext).callbackQuery;
      if (!query) return;

      try {
        await instance.api.answerCallbackQuery(query.id);
      } catch (error) {
        console.error("[Telegram] Failed to answer callback query:", error);
      }

      type CallbackPayload =
        | { k: string; a: "approve" | "deny" }
        | { k: string; a: "option"; i: number }
        | { k: string; a: "deny_reason" | "freeform" }
        | { k: string; a: "show_reasoning" };

      let payload: CallbackPayload;
      try {
        payload = JSON.parse(query.data ?? "") as CallbackPayload;
      } catch {
        console.error("[Telegram] Malformed callback_data:", query.data);
        return;
      }

      const { k, a: action } = payload;

      if (action === "show_reasoning") {
        const reasoning = reasoningByKey.get(k);
        if (!reasoning) return;
        const chatId = String(query.message?.chat.id ?? "");
        const messageId = query.message?.message_id;
        await instance.api
          .sendMessage(chatId, reasoning, {
            ...(messageId ? { reply_parameters: { message_id: messageId } } : {}),
          })
          .catch((error) => {
            console.error(
              "[Telegram] Failed to send reasoning reply:",
              error instanceof Error ? error.message : error,
            );
          });
        return;
      }

      const buttonEntry = buttonMessages.get(k);
      if (!buttonEntry) return;

      const { requestId } = buttonEntry;
      const chatId = String(query.message?.chat.id ?? buttonEntry.chatId);
      const senderId = String(query.from.id);
      const senderName =
        query.from.username ?? query.from.first_name ?? undefined;

      if (action === "deny_reason" || action === "freeform") {
        awaitingFeedback.set(chatId, { requestId, action, buttonKey: k });
        const prompt =
          action === "deny_reason"
            ? "Please type your reason for denying."
            : "Please type your answer.";
        await instance.api.sendMessage(chatId, prompt, {});
        return;
      }

      let syntheticText: string;
      let confirmationText: string;

      if (action === "approve") {
        syntheticText = "approve";
        confirmationText = "✅ Approved";
      } else if (action === "deny") {
        syntheticText = "deny";
        confirmationText = "❌ Denied";
      } else if (action === "option") {
        const i = (payload as { k: string; a: "option"; i: number }).i;
        const value = buttonEntry.options[i] ?? "";
        syntheticText = value;
        confirmationText = `Selected: ${value}`;
      } else {
        console.error("[Telegram] Unknown callback action:", action);
        return;
      }

      buttonMessages.delete(k);

      if (adapter.onMessage) {
        const inbound: InboundChannelMessage = {
          channel: "telegram",
          accountId: config.accountId,
          chatId,
          senderId,
          senderName,
          text: syntheticText,
          timestamp: Date.now(),
          messageId: String(query.message?.message_id ?? ""),
          chatType: query.message?.chat
            ? getTelegramChatType(query.message.chat)
            : "direct",
        };
        try {
          await adapter.onMessage(inbound);
        } catch (error) {
          console.error("[Telegram] Error processing callback query:", error);
        }
      }

      try {
        await instance.api.editMessageText(
          chatId,
          Number(buttonEntry.messageId),
          confirmationText,
        );
      } catch {
        await instance.api.sendMessage(chatId, confirmationText, {});
      }
    });

    instance.command("start", async (ctx) => {
      await ctx.reply(
        "Welcome! This bot is connected to Letta Code.\n\n" +
          "If this is your first time, send any message and you'll " +
          "receive a pairing code to connect to an agent.",
      );
    });

    instance.command("status", async (ctx) => {
      const botInfo = instance.botInfo;
      await ctx.reply(
        `Bot: @${botInfo.username ?? "unknown"}\n` +
          "Status: Running\n" +
          `DM Policy: ${config.dmPolicy}`,
      );
    });

    bot = instance;
    return instance;
  }

  const adapter: ChannelAdapter = {
    id: `telegram:${config.accountId}`,
    channelId: "telegram",
    accountId: config.accountId,
    name: "Telegram",

    async start(): Promise<void> {
      if (running) return;
      const telegramBot = await ensureBot();

      await telegramBot.init();
      const info = telegramBot.botInfo;
      console.log(
        `[Telegram] Bot started as @${info.username} (dm_policy: ${config.dmPolicy})`,
      );

      await new Promise<void>((resolve, reject) => {
        let started = false;

        void telegramBot
          .start({
            allowed_updates: ["message", "message_reaction", "callback_query"],
            onStart: () => {
              running = true;
              started = true;
              resolve();
            },
          })
          .catch((error) => {
            running = false;

            if (!started) {
              reject(error);
              return;
            }

            console.error(
              "[Telegram] Long-polling stopped unexpectedly:",
              error,
            );
          });
      });
    },

    async stop(): Promise<void> {
      for (const timer of typingIntervalByChatId.values()) {
        clearInterval(timer);
      }
      typingIntervalByChatId.clear();
      toolBlockStateByChatId.clear();
      toolBlockOperationByChatId.clear();

      for (const entry of bufferedMediaGroups.values()) {
        clearTimeout(entry.timer);
      }
      bufferedMediaGroups.clear();
      buttonMessages.clear();
      awaitingFeedback.clear();
      pendingReasoningByChatId.clear();
      reasoningByKey.clear();

      if (!running || !bot) return;
      await bot.stop();
      running = false;
      console.log("[Telegram] Bot stopped");
    },

    isRunning(): boolean {
      return running;
    },

    async handleStreamReasoning(
      chunk: string,
      sources: ChannelTurnSource[],
    ): Promise<void> {
      if (config.showReasoning === false) return;
      for (const source of sources) {
        pendingReasoningByChatId.set(
          source.chatId,
          (pendingReasoningByChatId.get(source.chatId) ?? "") + chunk,
        );
      }
    },

    async handleTurnLifecycleEvent(
      event: ChannelTurnLifecycleEvent,
    ): Promise<void> {
      if (!running) return;

      if (event.type === "queued") {
        startTypingInterval(event.source.chatId);
        return;
      }

      if (event.type === "processing") {
        for (const source of event.sources) {
          startTypingInterval(source.chatId);
        }
        return;
      }

      if (event.type === "tool_call") {
        if (event.toolName === "MessageChannel") return;
        for (const source of event.sources) {
          scheduleToolBlockUpdate(
            source.chatId,
            event.toolName,
            event.description,
          );
        }
        return;
      }

      // "finished"
      for (const source of event.sources) {
        stopTypingInterval(source.chatId);

        const pending = toolBlockOperationByChatId.get(source.chatId);
        if (pending) await pending.catch(() => {});
        toolBlockStateByChatId.delete(source.chatId);
        toolBlockOperationByChatId.delete(source.chatId);
        pendingReasoningByChatId.delete(source.chatId);
      }
    },

    async sendMessage(
      msg: OutboundChannelMessage,
    ): Promise<{ messageId: string }> {
      const telegramBot = await ensureBot();

      if (msg.reaction || msg.removeReaction) {
        const targetMessageId = msg.targetMessageId ?? msg.replyToMessageId;
        if (!targetMessageId) {
          throw new Error(
            "Telegram reactions require message_id (or reply_to_message_id) to identify the target message.",
          );
        }

        if (!msg.removeReaction) {
          const reaction = parseTelegramReactionInput(msg.reaction ?? "");
          if (!reaction) {
            throw new Error("Telegram reaction emoji cannot be empty.");
          }

          await telegramBot.api.setMessageReaction(
            msg.chatId,
            Number(targetMessageId),
            [reaction],
          );
        } else {
          await telegramBot.api.setMessageReaction(
            msg.chatId,
            Number(targetMessageId),
            [],
          );
        }

        return { messageId: targetMessageId };
      }

      if (msg.mediaPath) {
        const grammy = await ensureModule();
        const InputFile = resolveTelegramInputFileConstructor(grammy);
        const mediaPath = msg.mediaPath;
        const fileName = msg.fileName;
        const inputFile = new InputFile(mediaPath, fileName);
        const options = buildTelegramReplyOptions(msg);
        const uploadMethod = detectTelegramUploadMethod(mediaPath, fileName);

        const result = await (async () => {
          switch (uploadMethod) {
            case "photo":
              return await telegramBot.api.sendPhoto(
                msg.chatId,
                inputFile,
                options,
              );
            case "video":
              return await telegramBot.api.sendVideo(
                msg.chatId,
                inputFile,
                options,
              );
            case "audio":
              return await telegramBot.api.sendAudio(
                msg.chatId,
                inputFile,
                options,
              );
            case "voice":
              return await telegramBot.api.sendVoice(
                msg.chatId,
                inputFile,
                options,
              );
            case "animation":
              return await telegramBot.api.sendAnimation(
                msg.chatId,
                inputFile,
                options,
              );
            default:
              return await telegramBot.api.sendDocument(
                msg.chatId,
                inputFile,
                options,
              );
          }
        })();

        return { messageId: String(result.message_id) };
      }

      const opts: Record<string, unknown> = {};
      if (msg.replyToMessageId) {
        opts.reply_parameters = {
          message_id: Number(msg.replyToMessageId),
        };
      }
      if (msg.parseMode) {
        opts.parse_mode = msg.parseMode;
      }

      const pendingReasoning = pendingReasoningByChatId.get(msg.chatId);
      if (pendingReasoning) {
        const key = (callbackKeyCounter++).toString(36);
        reasoningByKey.set(key, pendingReasoning);
        opts.reply_markup = {
          inline_keyboard: [
            [
              {
                text: "🧠 Show reasoning",
                callback_data: JSON.stringify({ k: key, a: "show_reasoning" }),
              },
            ],
          ],
        };
      }

      const result = await telegramBot.api.sendMessage(
        msg.chatId,
        msg.text,
        opts,
      );
      return { messageId: String(result.message_id) };
    },

    async sendDirectReply(
      chatId: string,
      text: string,
      options?: { replyToMessageId?: string },
    ): Promise<void> {
      const telegramBot = await ensureBot();
      const reply_parameters = options?.replyToMessageId
        ? {
            message_id: Number(options.replyToMessageId),
          }
        : undefined;
      await telegramBot.api.sendMessage(
        chatId,
        text,
        reply_parameters ? { reply_parameters } : {},
      );
    },

    async handleControlRequestEvent(
      event: ChannelControlRequestEvent,
    ): Promise<void> {
      const telegramBot = await ensureBot();
      const reply_parameters =
        event.source.messageId || event.source.threadId
          ? {
              message_id: Number(
                event.source.threadId ?? event.source.messageId,
              ),
            }
          : undefined;

      if (event.kind === "generic_tool_approval") {
        const callbackKey = (callbackKeyCounter++).toString(36);
        const text = formatChannelControlRequestPrompt(event);
        const result = await telegramBot.api.sendMessage(
          event.source.chatId,
          text,
          {
            ...(reply_parameters ? { reply_parameters } : {}),
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "✅ Approve",
                    callback_data: JSON.stringify({
                      k: callbackKey,
                      a: "approve",
                    }),
                  },
                  {
                    text: "❌ Deny",
                    callback_data: JSON.stringify({
                      k: callbackKey,
                      a: "deny",
                    }),
                  },
                  {
                    text: "📝 Deny with Reason",
                    callback_data: JSON.stringify({
                      k: callbackKey,
                      a: "deny_reason",
                    }),
                  },
                ],
              ],
            },
          },
        );
        buttonMessages.set(callbackKey, {
          chatId: event.source.chatId,
          messageId: String(result.message_id),
          requestId: event.requestId,
          options: [],
        });
        return;
      }

      if (event.kind === "ask_user_question") {
        const input = event.input as {
          questions?: Array<{
            question?: string;
            options?: Array<{ label?: string }>;
          }>;
        };
        const firstQuestion = (input.questions ?? [])[0];
        const options = firstQuestion?.options ?? [];

        if (options.length > 0) {
          const callbackKey = (callbackKeyCounter++).toString(36);
          const text = formatChannelControlRequestPrompt(event);
          const optionButtons = options.map((option, optionIndex) => ({
            text: option.label ?? "Option",
            callback_data: JSON.stringify({
              k: callbackKey,
              a: "option",
              i: optionIndex,
            }),
          }));
          const result = await telegramBot.api.sendMessage(
            event.source.chatId,
            text,
            {
              ...(reply_parameters ? { reply_parameters } : {}),
              reply_markup: {
                inline_keyboard: [
                  optionButtons,
                  [
                    {
                      text: "✏️ Something else",
                      callback_data: JSON.stringify({
                        k: callbackKey,
                        a: "freeform",
                      }),
                    },
                  ],
                ],
              },
            },
          );
          buttonMessages.set(callbackKey, {
            chatId: event.source.chatId,
            messageId: String(result.message_id),
            requestId: event.requestId,
            options: options.map((o) => o.label ?? ""),
          });
          return;
        }
      }

      await telegramBot.api.sendMessage(
        event.source.chatId,
        formatChannelControlRequestPrompt(event),
        reply_parameters ? { reply_parameters } : {},
      );
    },

    onMessage: undefined,
  };

  return adapter;
}

/**
 * Validate a Telegram bot token by calling getMe().
 * Returns the bot username on success, throws on failure.
 */
export async function validateTelegramToken(
  token: string,
): Promise<{ username: string; id: number }> {
  const grammy = await loadGrammyModule();
  const Bot = resolveTelegramBotConstructor(grammy);
  const bot = new Bot(token);
  await bot.init();
  const info = bot.botInfo;
  return {
    username: info.username ?? "",
    id: info.id,
  };
}
