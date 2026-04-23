import {
  ensureChannelRuntimeInstalled,
  installChannelRuntime,
  isChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} from "../runtimeDeps";

// Local interface to avoid TypeScript errors for the uninstalled runtime dependency.
// TODO: Replace with typeof import("matrix-bot-sdk") once the package is installed.
export interface MatrixBotSdkLike {
  MatrixClient: new (...args: unknown[]) => unknown;
  SimpleFsStorageProvider: new (path: string) => unknown;
  RustSdkCryptoStorageProvider: new (
    path: string,
    storeType: unknown,
  ) => unknown;
  RustSdkCryptoStoreType: { Sled: string };
}

export async function loadMatrixBotSdkModule(): Promise<MatrixBotSdkLike> {
  return loadChannelRuntimeModule<MatrixBotSdkLike>("matrix", "matrix-bot-sdk");
}

export function isMatrixRuntimeInstalled(): boolean {
  return isChannelRuntimeInstalled("matrix");
}

export async function installMatrixRuntime(): Promise<void> {
  await installChannelRuntime("matrix");
}

export async function ensureMatrixRuntimeInstalled(): Promise<boolean> {
  return ensureChannelRuntimeInstalled("matrix");
}
