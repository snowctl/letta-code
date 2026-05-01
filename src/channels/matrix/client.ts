// src/channels/matrix/client.ts
//
// HTTP transport and matrix-bot-sdk client construction. Owns the undici
// dispatcher singleton and the fetch-based request shim that replaces
// matrix-bot-sdk's deprecated `request` library. See the doc-block below
// for why we don't use Bun's built-in fetch directly.
import { join } from "node:path";
import { getChannelDir } from "../config";
import {
  ensureMatrixCryptoUpToDate,
  type LegacyRequestCallback,
  type LegacyRequestParams,
  type LegacyRequestResponse,
  loadMatrixBotSdkModule,
  loadMatrixCryptoModule,
  loadUndiciModule,
  type UndiciDispatcher,
  type UndiciLike,
} from "./runtime";

// ── HTTP transport ────────────────────────────────────────────────────────────
// matrix-bot-sdk@0.8.0 ships with the deprecated `request` library. Its
// `timeout` option is implemented via socket-level timer events on Node's `net`
// module — which Bun polyfills imperfectly — so a stalled `/sync` long-poll
// can hang past its 40 s timeout and never recover. The fetch-based
// replacement below uses AbortSignal-driven timeouts at the JS event-loop
// level, which works identically under Node and Bun.
//
// Why undici instead of the platform `fetch`: Bun's built-in fetch keeps
// connections alive in an internal pool we cannot tune. In production we
// observed sockets that the homeserver (or an intermediate proxy) silently
// closed during an idle window staying in Bun's pool as "alive"; every
// reuse then hung until our AbortSignal fired, producing exact-on-timeout
// errors in tight bursts and silencing the matrix channel for hours.
// undici exposes a `keepAliveTimeout` knob — we set it tighter than any
// reasonable proxy idle timeout (10 s) so undici evicts pooled sockets
// before the server can quietly close them out from under us. We keep
// pooling on for tight intra-sync bursts (e.g. fetching room state),
// which are well within the 10 s window. Installed via `setRequestFn`
// in `createMatrixBotSdkClient()`.

function buildLegacyRequestUrl(params: LegacyRequestParams): string {
  if (!params.qs) return params.uri;
  const url = new URL(params.uri);
  for (const [key, value] of Object.entries(params.qs)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      // matrix-bot-sdk passes `useQuerystring: true, arrayFormat: "repeat"`,
      // which means `?key=v1&key=v2`. URLSearchParams.append matches that.
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Module-scoped lazy singletons. One Agent and one fetch reference shared
 *  across every matrix adapter instance in this process. */
let cachedUndici: UndiciLike | null = null;
let cachedDispatcher: UndiciDispatcher | null = null;

async function getUndiciDispatcher(): Promise<{
  undici: UndiciLike;
  dispatcher: UndiciDispatcher;
}> {
  if (cachedUndici && cachedDispatcher) {
    return { undici: cachedUndici, dispatcher: cachedDispatcher };
  }
  const undici = await loadUndiciModule();
  // Tight idle-eviction values: any pooled socket idle longer than
  // keepAliveTimeout is closed by undici before the server's idle-close
  // can leave it stale in our pool. keepAliveMaxTimeout caps the absolute
  // age of any pooled socket. bodyTimeout is a belt on top of our own
  // AbortSignal so a half-open response can't hang silently.
  // headersTimeout is intentionally omitted: Matrix sync long-polling holds
  // connections open for 30 s before sending any response headers, which
  // would cause a 15 s headersTimeout to fire on every sync cycle.
  const dispatcher = new undici.Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 30_000,
    bodyTimeout: 65_000,
    connect: { timeout: 10_000 },
  });
  cachedUndici = undici;
  cachedDispatcher = dispatcher;
  return { undici, dispatcher };
}

function makeFetchBackedRequestFn(
  undici: UndiciLike,
  dispatcher: UndiciDispatcher,
) {
  return async function fetchBackedRequestFn(
    params: LegacyRequestParams,
    callback: LegacyRequestCallback,
  ): Promise<void> {
    const timeoutMs = params.timeout > 0 ? params.timeout : 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new Error(`matrix-bot-sdk request timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    // Buffer is fetch-compatible at runtime (Node + Bun), but TS's BodyInit
    // doesn't list it; copy out into a fresh ArrayBuffer so the type matches.
    let requestBody: BodyInit | undefined;
    if (params.body === undefined) {
      requestBody = undefined;
    } else if (typeof params.body === "string") {
      requestBody = params.body;
    } else {
      const slice = params.body.buffer.slice(
        params.body.byteOffset,
        params.body.byteOffset + params.body.byteLength,
      );
      requestBody = slice as ArrayBuffer;
    }

    try {
      const response = await undici.fetch(buildLegacyRequestUrl(params), {
        method: params.method,
        headers: params.headers,
        body: requestBody,
        signal: controller.signal,
        dispatcher,
      });
      const buf = Buffer.from(await response.arrayBuffer());
      const responseBody: string | Buffer =
        params.encoding === null ? buf : buf.toString("utf-8");
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const responseLike: LegacyRequestResponse = {
        statusCode: response.status,
        headers,
        body: responseBody,
      };
      callback(null, responseLike, responseBody);
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── MatrixBotSdkClient interface ──────────────────────────────────────────────

export interface MatrixBotSdkClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: string, handler: (...args: unknown[]) => unknown): this;
  sendMessage(roomId: string, content: unknown): Promise<string>;
  sendEvent(roomId: string, type: string, content: unknown): Promise<string>;
  redactEvent(roomId: string, eventId: string): Promise<string>;
  joinRoom(roomId: string): Promise<string>;
  uploadContent(
    data: Buffer,
    contentType: string,
    filename: string,
  ): Promise<string>;
  mxcToHttp(mxc: string): string;
  downloadContent(
    mxcUrl: string,
  ): Promise<{ data: Buffer; contentType: string }>;
  getUserProfile(userId: string): Promise<{ displayname?: string }>;
  getJoinedRoomMembers(roomId: string): Promise<string[]>;
  setTyping(roomId: string, isTyping: boolean, timeout?: number): Promise<void>;
}

// ── Client construction ───────────────────────────────────────────────────────

export interface CreateClientArgs {
  homeserverUrl: string;
  accessToken: string;
  accountId: string;
  e2ee: boolean;
}

export async function createMatrixBotSdkClient(
  args: CreateClientArgs,
): Promise<MatrixBotSdkClient> {
  const { homeserverUrl, accessToken, accountId, e2ee } = args;

  // If the installed crypto-nodejs predates 0.5.0, it can't expose the
  // cross-signing upload requests. Upgrade before loading the SDK.
  await ensureMatrixCryptoUpToDate();

  const matrixBotSdk = await loadMatrixBotSdkModule();

  // Replace matrix-bot-sdk's deprecated `request` library with an undici-
  // backed fetch shim. AbortSignal-driven timeouts replace the legacy lib's
  // broken socket-level timer, and undici's `Agent` gives us the pool-
  // eviction knobs Bun's built-in fetch lacks (see top of file). The
  // dispatcher is module-scoped and reused across createMatrixBotSdkClient() calls,
  // so a respawn of the same agent doesn't churn pools.
  const { undici, dispatcher } = await getUndiciDispatcher();
  matrixBotSdk.setRequestFn(makeFetchBackedRequestFn(undici, dispatcher));

  const {
    MatrixClient,
    SimpleFsStorageProvider,
    RustSdkCryptoStorageProvider,
    RustSdkCryptoStoreType,
  } = matrixBotSdk;

  const channelDir = getChannelDir("matrix");
  const storageDir = join(channelDir, accountId);
  const storagePath = join(storageDir, "storage.json");
  const cryptoPath = join(storageDir, "crypto");

  const storageProvider = new SimpleFsStorageProvider(storagePath);

  let cryptoProvider: unknown;
  if (e2ee) {
    try {
      // matrix-bot-sdk@0.8.0's JS doesn't re-export RustSdkCryptoStoreType
      // even though the .d.ts claims it does. Load StoreType directly from
      // @matrix-org/matrix-sdk-crypto-nodejs as the primary source, and fall
      // back to whatever matrix-bot-sdk exports (in case a future version
      // does re-export it). Sled was renamed to Sqlite in crypto-nodejs ≥ 0.3.
      let storeValue: string | number | undefined =
        RustSdkCryptoStoreType?.Sqlite ?? RustSdkCryptoStoreType?.Sled;

      if (storeValue === undefined) {
        const cryptoMod = await loadMatrixCryptoModule();
        storeValue = cryptoMod.StoreType?.Sqlite ?? cryptoMod.StoreType?.Sled;
      }

      if (storeValue === undefined) {
        throw new Error(
          "StoreType not available from matrix-bot-sdk or @matrix-org/matrix-sdk-crypto-nodejs",
        );
      }

      cryptoProvider = new RustSdkCryptoStorageProvider(cryptoPath, storeValue);
    } catch (err) {
      console.warn(
        "[matrix] E2EE unavailable (Rust crypto addon failed to load); running unencrypted:",
        err,
      );
    }
  }

  return new (
    MatrixClient as unknown as new (
      homeserverUrl: string,
      accessToken: string,
      storageProvider: unknown,
      cryptoProvider?: unknown,
    ) => MatrixBotSdkClient
  )(homeserverUrl, accessToken, storageProvider, cryptoProvider);
}
