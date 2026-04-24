import type {
  ChannelAccount,
  ChannelAdapter,
  ChannelChatType,
  ChannelRoute,
  OutboundChannelMessage,
  SupportedChannelId,
} from "./types";

export interface ChannelPluginMetadata {
  id: SupportedChannelId;
  displayName: string;
  runtimePackages: string[];
  runtimeModules: string[];
  /**
   * Packages (top-level or transitive) whose install scripts must run during
   * channel runtime install. Written into the generated runtime manifest as
   * `trustedDependencies` so bun will execute their postinstall hooks — needed
   * for packages that download native binaries on install
   * (e.g. `@matrix-org/matrix-sdk-crypto-nodejs`'s `download-lib.js`).
   */
  runtimeTrustedDependencies?: readonly string[];
  /**
   * Version pins to force onto transitive dependencies. Written into the
   * runtime manifest as `overrides` (respected by bun, npm, and pnpm). Used
   * when we need a newer binding than a SDK declares — e.g. matrix-bot-sdk
   * 0.8.0 declares ^0.4.0 for matrix-sdk-crypto-nodejs but we need 0.5.x for
   * cross-signing bootstrap to return upload requests.
   */
  runtimeOverrides?: Readonly<Record<string, string>>;
}

export type ChannelMessageActionName = "send" | "react" | "upload-file";

export interface ChannelMessageToolSchemaContribution {
  properties: Record<string, unknown>;
  visibility?: "all-configured";
}

/**
 * Plugin-owned discovery for the shared MessageChannel tool.
 * Channel plugins advertise their supported actions and any extra schema
 * fragments here so the public tool surface stays singular while the
 * capabilities remain channel-specific.
 */
export interface ChannelMessageToolDiscovery {
  actions?: readonly ChannelMessageActionName[] | null;
  schema?:
    | ChannelMessageToolSchemaContribution
    | ChannelMessageToolSchemaContribution[]
    | null;
}

export interface ChannelMessageActionRequest {
  action: ChannelMessageActionName;
  channel: SupportedChannelId;
  chatId: string;
  message?: string;
  replyToMessageId?: string;
  threadId?: string | null;
  messageId?: string;
  emoji?: string;
  remove?: boolean;
  mediaPath?: string;
  filename?: string;
  title?: string;
}

export interface ChannelResolvedMessageTarget {
  chatId: string;
  chatType?: ChannelChatType;
  threadId?: string | null;
  label?: string;
}

export interface ChannelMessageActionContext {
  request: ChannelMessageActionRequest;
  route: ChannelRoute;
  adapter: ChannelAdapter;
  formatText: (
    text: string,
  ) => Pick<OutboundChannelMessage, "text" | "parseMode">;
}

/**
 * Channel-owned action surface for the shared MessageChannel tool.
 * This mirrors the OpenClaw pattern: one top-level tool, with each channel
 * plugin owning action discovery and execution underneath it.
 */
export interface ChannelMessageActionAdapter {
  describeMessageTool(params: {
    accountId?: string | null;
  }): ChannelMessageToolDiscovery;
  resolveMessageTarget?(params: {
    account: ChannelAccount;
    target: string;
  }): Promise<ChannelResolvedMessageTarget>;
  handleAction(ctx: ChannelMessageActionContext): Promise<string>;
}

export interface ChannelPlugin {
  metadata: ChannelPluginMetadata;
  createAdapter(
    account: ChannelAccount,
  ): Promise<ChannelAdapter> | ChannelAdapter;
  runSetup?(): Promise<boolean>;
  messageActions?: ChannelMessageActionAdapter;
}
