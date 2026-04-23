// Stub - implementation in Task 6
import type {
  ChannelMessageActionAdapter,
  ChannelMessageToolDiscovery,
} from "../pluginTypes";

export const matrixMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool(_params: {
    accountId?: string | null;
  }): ChannelMessageToolDiscovery {
    throw new Error("Matrix message actions not yet implemented");
  },
  async handleAction(): Promise<string> {
    throw new Error("Matrix message actions not yet implemented");
  },
};
