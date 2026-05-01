// src/channels/matrix/botCommands.ts
import type { Letta } from "@letta-ai/letta-client";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { getClient } from "../../agent/client";
import {
  handleOperatorCommand,
  type OperatorCommandContext,
} from "../operator-commands";
import { getChannelRegistry } from "../registry";
import type { MatrixChannelAccount } from "../types";
import { markdownToMatrixHtml } from "./htmlFormat";
import type { MatrixSender } from "./matrixSender";

// ── Factory ───────────────────────────────────────────────────────────────────

export interface BotCommandsDeps {
  sender: MatrixSender;
  account: MatrixChannelAccount;
  accountId: string;
  userId: string;
  dmPolicy: string;
}

export interface BotCommands {
  handleBotCommand(
    roomId: string,
    body: string,
    event: Record<string, unknown>,
  ): Promise<void>;
  dispatchOperatorCommand(
    command: string,
    args: string[],
    chatId: string,
  ): Promise<string>;
  /** Exposed so adapter.stop() can clear it. */
  getConvListCache(): Map<string, Conversation[]>;
}

export function createBotCommands(deps: BotCommandsDeps): BotCommands {
  const { sender, accountId, userId, dmPolicy } = deps;

  // Per-adapter conv list cache keyed by chatId
  const convListCache = new Map<string, Conversation[]>();

  async function dispatchOperatorCommand(
    command: string,
    args: string[],
    chatId: string,
  ): Promise<string> {
    if (command === "help") {
      return handleOperatorCommand("help", [], {
        commandPrefix: "!",
        agentId: "",
        chatId,
        client: {} as Letta,
        getCurrentConvId: () => "default",
        setCurrentConvId: async () => {},
        requestCancel: () => false,
        getConvListCache: () => null,
        setConvListCache: () => {},
      });
    }
    const registry = getChannelRegistry();
    const route = registry?.getRoute("matrix", chatId, accountId);
    if (!route) return "This chat is not connected to an agent.";
    const client = await getClient();
    const opCtx: OperatorCommandContext = {
      agentId: route.agentId,
      chatId,
      commandPrefix: "!",
      client,
      getCurrentConvId: () =>
        getChannelRegistry()?.getRoute("matrix", chatId, accountId)
          ?.conversationId ?? "default",
      setCurrentConvId: async (id) => {
        getChannelRegistry()?.updateRouteConversation(
          "matrix",
          chatId,
          accountId,
          id,
        );
      },
      requestCancel: () => {
        const liveConvId =
          getChannelRegistry()?.getRoute("matrix", chatId, accountId)
            ?.conversationId ?? "default";
        return registry?.cancelActiveRun(route.agentId, liveConvId) ?? false;
      },
      getConvListCache: () => convListCache.get(chatId) ?? null,
      setConvListCache: (list) => {
        if (list === null) {
          convListCache.delete(chatId);
        } else {
          convListCache.set(chatId, list);
        }
      },
      onContextWindowChange: (size) => {
        const liveConvId =
          getChannelRegistry()?.getRoute("matrix", chatId, accountId)
            ?.conversationId ?? "default";
        getChannelRegistry()?.updateContextWindowMax(
          route.agentId,
          liveConvId,
          size,
        );
      },
    };
    return handleOperatorCommand(command, args, opCtx);
  }

  async function handleBotCommand(
    roomId: string,
    body: string,
    _event: Record<string, unknown>,
  ): Promise<void> {
    const parts = body.trim().split(/\s+/);
    const command = parts[0]?.toLowerCase();

    if (command === "!start") {
      await sender.sendNew(roomId, {
        text: "Hi! I'm a Letta AI assistant.\n\nTo pair this conversation with an agent, ask your admin for a pairing code and send it here.",
      });
      return;
    }

    if (command === "!status") {
      await sender.sendNew(roomId, {
        text: `Bot: ${userId}\nDM Policy: ${dmPolicy}`,
      });
      return;
    }

    const sendReply = async (text: string) => {
      const { html, plaintext } = markdownToMatrixHtml(text);
      await sender.sendNew(roomId, {
        text: plaintext,
        html,
      });
    };

    if (command === "!cancel") {
      await sendReply(await dispatchOperatorCommand("cancel", [], roomId));
      return;
    }

    if (command === "!compact") {
      await sendReply(await dispatchOperatorCommand("compact", [], roomId));
      return;
    }

    if (command === "!recompile") {
      await sendReply(await dispatchOperatorCommand("recompile", [], roomId));
      return;
    }

    if (command === "!conv") {
      const args = parts.slice(1).filter(Boolean);
      await sendReply(await dispatchOperatorCommand("conv", args, roomId));
      return;
    }

    if (command === "!reset") {
      const args = parts.slice(1).filter(Boolean);
      await sendReply(await dispatchOperatorCommand("reset", args, roomId));
      return;
    }

    if (command === "!models") {
      await sendReply(await dispatchOperatorCommand("models", [], roomId));
      return;
    }

    if (command === "!model") {
      const args = parts.slice(1).filter(Boolean);
      await sendReply(await dispatchOperatorCommand("model", args, roomId));
      return;
    }

    if (command === "!ctx") {
      const args = parts.slice(1).filter(Boolean);
      await sendReply(await dispatchOperatorCommand("ctx", args, roomId));
      return;
    }

    if (command === "!help") {
      await sendReply(await dispatchOperatorCommand("help", [], roomId));
      return;
    }
  }

  return {
    handleBotCommand,
    dispatchOperatorCommand,
    getConvListCache: () => convListCache,
  };
}
