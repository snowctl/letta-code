import type { SupportedChannelId } from "./types";

export type ChannelToolScopeEntry = {
  channelId: SupportedChannelId;
  accountId?: string | null;
};

export type ChannelToolScope = {
  channels: ChannelToolScopeEntry[];
};
