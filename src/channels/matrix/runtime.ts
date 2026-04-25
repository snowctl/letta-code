import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  RustSdkCryptoStoreType:
    | { Sled?: string | number; Sqlite?: number }
    | undefined;
  // matrix-bot-sdk exposes setRequestFn to swap the underlying HTTP client.
  // We use it to replace the deprecated `request` library (whose timeout
  // implementation hangs forever under Bun on long-poll /sync) with a
  // fetch-based wrapper that enforces timeouts via AbortSignal.
  setRequestFn: (
    fn: (
      params: LegacyRequestParams,
      callback: LegacyRequestCallback,
    ) => unknown,
  ) => void;
}

/**
 * Subset of the legacy `request` library's options object that matrix-bot-sdk
 * actually populates in `lib/http.js#doHttpRequest`. We model just these keys
 * because the request fn is the boundary between matrix-bot-sdk and our
 * fetch-based replacement — anything outside this list is ignored.
 */
export interface LegacyRequestParams {
  uri: string;
  method: string;
  qs?: Record<string, unknown> | null;
  body?: string | Buffer;
  headers: Record<string, string>;
  /** Wall-clock timeout in milliseconds. Enforced via AbortSignal.timeout. */
  timeout: number;
  /** When `null`, return body as Buffer. When `undefined`, return as string. */
  encoding?: string | null;
}

export interface LegacyRequestResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

export type LegacyRequestCallback = (
  err: Error | null,
  response?: LegacyRequestResponse,
  body?: string | Buffer,
) => void;

export interface MatrixCryptoModuleLike {
  StoreType: { Sled?: string | number; Sqlite?: number } | undefined;
  // Added in @matrix-org/matrix-sdk-crypto-nodejs 0.5.0. Its presence is the
  // signal that `OlmMachine.bootstrapCrossSigning` returns the upload
  // requests we need — the 0.4.x binding silently dropped that return value.
  CrossSigningBootstrapRequests?: unknown;
}

/**
 * Subset of `undici`'s public API used by the matrix HTTP transport.
 *
 * We replace Bun's built-in `fetch` with undici's so we can attach a custom
 * `Agent` (dispatcher). Bun's pool has been observed to retain TCP sockets
 * that the homeserver (or an intermediate proxy) silently closed during an
 * idle window, after which every reuse hangs until our `AbortSignal` fires.
 * undici's pool has explicit eviction knobs (`keepAliveTimeout`,
 * `keepAliveMaxTimeout`) that let us close idle sockets *before* the server
 * does, eliminating the dead-reuse failure mode without disabling pooling
 * entirely.
 */
export interface UndiciDispatcher {
  destroy(): Promise<void>;
}

export interface UndiciAgentOptions {
  keepAliveTimeout?: number;
  keepAliveMaxTimeout?: number;
  bodyTimeout?: number;
  headersTimeout?: number;
  connect?: { timeout?: number };
}

export interface UndiciFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  signal?: AbortSignal;
  dispatcher?: UndiciDispatcher;
}

export interface UndiciResponseLike {
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface UndiciLike {
  Agent: new (opts?: UndiciAgentOptions) => UndiciDispatcher;
  fetch: (
    url: string,
    init?: UndiciFetchOptions,
  ) => Promise<UndiciResponseLike>;
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

export async function loadUndiciModule(): Promise<UndiciLike> {
  return loadChannelRuntimeModule<UndiciLike>("matrix", "undici");
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
  await ensureMatrixCryptoUpToDate();
  return installed;
}

/**
 * Force a reinstall if the installed crypto-nodejs binding predates 0.5.0.
 * We detect by checking whether `CrossSigningBootstrapRequests` is exported —
 * that class was added in 0.5.0 and is required for cross-signing bootstrap
 * to return the upload requests. Wipes node_modules before reinstall so the
 * `overrides` in the manifest can hoist the new version past matrix-bot-sdk's
 * ^0.4.0 declaration.
 */
export async function ensureMatrixCryptoUpToDate(): Promise<boolean> {
  // IMPORTANT: detect the installed version by reading package.json, NOT by
  // importing the module. Once the native .node binary of 0.4.x is loaded
  // into this process it stays resident even after we wipe node_modules —
  // any later `require()` by matrix-bot-sdk gets the cached 0.4.x, defeating
  // the upgrade until the next process restart.
  const runtimeDir = getChannelRuntimeDir("matrix");
  const pkgJsonPath = join(
    runtimeDir,
    "node_modules",
    "@matrix-org",
    "matrix-sdk-crypto-nodejs",
    "package.json",
  );

  let installedVersion: string | null = null;
  try {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(pkgJsonPath, "utf-8")) as {
      version?: string;
    };
    installedVersion = pkg.version ?? null;
  } catch {
    // Not installed — the outer ensureMatrixRuntimeInstalled handles that case.
  }

  if (installedVersion && isCryptoVersionAtLeast(installedVersion, [0, 5, 0])) {
    return false;
  }

  console.log(
    `[matrix] upgrading @matrix-org/matrix-sdk-crypto-nodejs ${
      installedVersion ?? "(missing)"
    } → 0.5.1+ for cross-signing support…`,
  );
  await rm(join(runtimeDir, "node_modules"), { recursive: true, force: true });
  await installChannelRuntime("matrix");
  await ensureTurt2LiveShim();
  return true;
}

function isCryptoVersionAtLeast(
  version: string,
  min: readonly [number, number, number],
): boolean {
  const parts = version.split(".").map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}
