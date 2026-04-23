import {
  ensureChannelRuntimeInstalled,
  installChannelRuntime,
  isChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} from "../runtimeDeps";

// Use a local interface to avoid TypeScript errors for an uninstalled dependency
export interface MatrixBotSdkLike {
  MatrixClient: new (options: unknown) => unknown;
  MemoryStorageProvider: new () => unknown;
  SimpleFsStorageProvider: new (path: string) => unknown;
  RichReply: new (body: unknown, formattedBody: unknown) => unknown;
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
