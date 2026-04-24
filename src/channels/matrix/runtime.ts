import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureChannelRuntimeInstalled,
  getChannelRuntimeDir,
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
  RustSdkCryptoStoreType: { Sled?: string | number; Sqlite?: number } | undefined;
}

export interface MatrixCryptoModuleLike {
  StoreType: { Sled?: string | number; Sqlite?: number } | undefined;
}

export async function loadMatrixBotSdkModule(): Promise<MatrixBotSdkLike> {
  return loadChannelRuntimeModule<MatrixBotSdkLike>("matrix", "matrix-bot-sdk");
}

export async function loadMatrixCryptoModule(): Promise<MatrixCryptoModuleLike> {
  return loadChannelRuntimeModule<MatrixCryptoModuleLike>(
    "matrix",
    "@matrix-org/matrix-sdk-crypto-nodejs",
  );
}

export function isMatrixRuntimeInstalled(): boolean {
  return isChannelRuntimeInstalled("matrix");
}

// matrix-bot-sdk@0.8.0 InternalOlmMachineFactory.js requires the old
// @turt2live scope (since renamed to @matrix-org). Create a shim that
// re-exports from the installed @matrix-org package so E2EE works without
// installing the deprecated scoped package separately.
async function ensureTurt2LiveShim(): Promise<void> {
  const shimDir = join(
    getChannelRuntimeDir("matrix"),
    "node_modules",
    "@turt2live",
    "matrix-sdk-crypto-nodejs",
  );
  if (existsSync(join(shimDir, "index.js"))) return;
  await mkdir(shimDir, { recursive: true });
  await writeFile(
    join(shimDir, "package.json"),
    `${JSON.stringify(
      { name: "@turt2live/matrix-sdk-crypto-nodejs", main: "index.js" },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await writeFile(
    join(shimDir, "index.js"),
    `module.exports = require("@matrix-org/matrix-sdk-crypto-nodejs");\n`,
    "utf-8",
  );
}

export async function installMatrixRuntime(): Promise<void> {
  await installChannelRuntime("matrix");
  await ensureTurt2LiveShim();
}

export async function ensureMatrixRuntimeInstalled(): Promise<boolean> {
  const installed = await ensureChannelRuntimeInstalled("matrix");
  await ensureTurt2LiveShim();
  return installed;
}
