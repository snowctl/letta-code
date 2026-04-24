// Bootstrap + upload cross-signing keys for a Matrix bot account.
//
// Without this, Element X (and any other client that enforces cross-signing
// trust) shows "Encrypted by a device not verified by its owner" on every
// message the bot sends: the bot's device is a valid E2EE participant but
// isn't signed by its own user's self-signing key, so the UI can't establish
// the "devices verified by their owner" trust edge.
//
// matrix-bot-sdk does not expose cross-signing APIs. We reach through to the
// underlying `OlmMachine` (the same one Element's Rust SDK uses), call
// `bootstrapCrossSigning`, and dispatch the resulting upload requests over
// raw HTTP. The initial upload is no-UIA under MSC3967 (Synapse default).
//
// Requires @matrix-org/matrix-sdk-crypto-nodejs ≥ 0.5.0 — the 0.4.x binding
// declares the return type as Promise<void> and silently drops the upload
// requests, making bootstrap impossible to observe from JS.

interface SignatureUploadRequestLike {
  readonly id?: string;
  readonly body: string;
}

interface KeysUploadRequestLike {
  readonly id: string;
  readonly type: number;
  readonly body: string;
}

interface CrossSigningBootstrapRequestsLike {
  readonly uploadKeysReq?: KeysUploadRequestLike;
  readonly uploadSigningKeysReq: string;
  readonly uploadSignaturesReq: SignatureUploadRequestLike;
}

interface CrossSigningStatusLike {
  readonly hasMaster: boolean;
  readonly hasSelfSigning: boolean;
  readonly hasUserSigning: boolean;
}

interface OlmMachineLike {
  crossSigningStatus(): Promise<CrossSigningStatusLike>;
  bootstrapCrossSigning(
    reset: boolean,
  ): Promise<CrossSigningBootstrapRequestsLike>;
  markRequestAsSent(
    requestId: string,
    requestType: number,
    response: string,
  ): Promise<boolean>;
}

interface ClientWithCrypto {
  crypto?: {
    engine?: {
      machine?: OlmMachineLike;
    };
  };
}

// RequestType enum from @matrix-org/matrix-sdk-crypto-nodejs — stable across
// 0.4 and 0.5; hardcoded here so we don't have to load the enum export.
const REQUEST_TYPE_KEYS_UPLOAD = 0;

async function postJson(
  homeserverUrl: string,
  accessToken: string,
  path: string,
  body: string,
): Promise<{ status: number; json: unknown }> {
  const url = new URL(path, homeserverUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Leave json as null; caller decides whether to care.
  }
  return { status: res.status, json };
}

/**
 * Idempotently ensure the bot's cross-signing identity is bootstrapped and
 * uploaded to the homeserver. No-op if already bootstrapped. Safe to call on
 * every adapter start.
 *
 * On a fresh account, this:
 *   1. Generates master, self-signing, and user-signing keys locally.
 *   2. POSTs them to `/keys/device_signing/upload` (no UIA on first bootstrap
 *      under MSC3967 / modern Synapse; with MAS, the first upload is also
 *      UIA-exempt — subsequent resets require browser-based OAuth).
 *   3. POSTs `/keys/signatures/upload` to publish the self-signing signature
 *      over the current device.
 *
 * Errors are thrown; callers should catch and log, not crash. A failed upload
 * leaves the local crypto store with private cross-signing keys that the
 * homeserver doesn't know about; we'll retry on the next adapter start.
 */
export async function ensureCrossSigning(
  client: ClientWithCrypto,
  homeserverUrl: string,
  accessToken: string,
): Promise<"already-bootstrapped" | "bootstrapped"> {
  const machine = client.crypto?.engine?.machine;
  if (!machine) {
    throw new Error(
      "[matrix] cross-signing: could not reach OlmMachine via client.crypto.engine.machine — matrix-bot-sdk internals changed?",
    );
  }

  const status = await machine.crossSigningStatus();
  if (status.hasMaster && status.hasSelfSigning && status.hasUserSigning) {
    return "already-bootstrapped";
  }

  const requests = await machine.bootstrapCrossSigning(false);

  // CrossSigningBootstrapRequests is undefined at runtime if we're on the
  // 0.4.x binding — bootstrapCrossSigning returns void there. Defensive check.
  if (!requests || typeof requests.uploadSigningKeysReq !== "string") {
    throw new Error(
      "[matrix] cross-signing: bootstrapCrossSigning returned no upload requests — crypto-nodejs < 0.5.0 is installed?",
    );
  }

  // (a) Re-upload device keys if the bootstrap requires it. Usually undefined
  // because device keys were already uploaded during crypto.prepare().
  if (requests.uploadKeysReq) {
    const resp = await postJson(
      homeserverUrl,
      accessToken,
      "/_matrix/client/v3/keys/upload",
      requests.uploadKeysReq.body,
    );
    if (resp.status !== 200) {
      throw new Error(
        `[matrix] cross-signing: /keys/upload returned ${resp.status}: ${JSON.stringify(resp.json)}`,
      );
    }
    await machine.markRequestAsSent(
      requests.uploadKeysReq.id,
      REQUEST_TYPE_KEYS_UPLOAD,
      JSON.stringify(resp.json ?? {}),
    );
  }

  // (b) Upload cross-signing public keys (master, self-signing, user-signing).
  // The binding docs state this request has no ID and does not flow through
  // markRequestAsSent — it's a standalone body.
  const signingKeysResp = await postJson(
    homeserverUrl,
    accessToken,
    "/_matrix/client/v3/keys/device_signing/upload",
    requests.uploadSigningKeysReq,
  );
  if (signingKeysResp.status !== 200) {
    throw new Error(
      `[matrix] cross-signing: /keys/device_signing/upload returned ${signingKeysResp.status}: ${JSON.stringify(signingKeysResp.json)}`,
    );
  }

  // (c) Upload the self-signing signature over the current device.
  const signaturesResp = await postJson(
    homeserverUrl,
    accessToken,
    "/_matrix/client/v3/keys/signatures/upload",
    requests.uploadSignaturesReq.body,
  );
  if (signaturesResp.status !== 200) {
    throw new Error(
      `[matrix] cross-signing: /keys/signatures/upload returned ${signaturesResp.status}: ${JSON.stringify(signaturesResp.json)}`,
    );
  }

  return "bootstrapped";
}
