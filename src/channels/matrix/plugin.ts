import type { ChannelPlugin } from "../pluginTypes";
import type { ChannelAccount, MatrixChannelAccount } from "../types";
import { createMatrixAdapter } from "./adapter";
import { matrixMessageActions } from "./messageActions";
import { runMatrixSetup } from "./setup";

export const matrixChannelPlugin: ChannelPlugin = {
  metadata: {
    id: "matrix",
    displayName: "Matrix",
    runtimePackages: ["matrix-bot-sdk@0.8.0", "undici@^7"],
    runtimeModules: ["matrix-bot-sdk", "undici"],
    runtimeTrustedDependencies: ["@matrix-org/matrix-sdk-crypto-nodejs"],
  },
  createAdapter(account: ChannelAccount) {
    return createMatrixAdapter(account as MatrixChannelAccount);
  },
  messageActions: matrixMessageActions,
  runSetup() {
    return runMatrixSetup();
  },
};
