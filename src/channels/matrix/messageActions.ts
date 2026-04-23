// Stub - implementation in Task 6
import type { ChannelMessageActionAdapter } from "../pluginTypes";

export const matrixMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool(_params: {
    accountId?: string | null;
  }): Record<string, never> {
    throw new Error("Matrix message actions not yet implemented");
  },
  async handleAction(): Promise<string> {
    throw new Error("Matrix message actions not yet implemented");
  },
};
