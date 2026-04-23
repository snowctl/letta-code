import type { ChannelPlugin } from "../pluginTypes";
import type { ChannelAdapter } from "../types";

export const matrixChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "matrix",
    displayName: "Matrix",
    runtimePackages: ["matrix-bot-sdk@0.8.0"],
    runtimeModules: ["matrix-bot-sdk"],
  },
  async createAdapter(): Promise<ChannelAdapter> {
    throw new Error("Matrix adapter not yet implemented");
  },
};
