# Matrix cross-signing for bot accounts — reference

_Written 2026-04-24 after debugging this end-to-end against Synapse 1.150 + MAS 1.14. Captures gotchas that aren't obvious from the Matrix spec or matrix-bot-sdk docs._

## What cross-signing fixes

Without it, Element X (and any strict client) shows **"Encrypted by a device not verified by its owner"** on every bot message. Encryption still works — Megolm sessions exchange normally — but the UI trust shield stays amber/red.

The warning means: the sender's own self-signing key (SSK) did not sign the device that sent this message. Element X treats this as "we can't confirm the bot owner actually owns this device."

Fix is to ensure the bot user has a cross-signing identity (master + self-signing + user-signing keys) published on the homeserver, and the bot's current device is signed by that self-signing key.

## Architecture in this repo

- `src/channels/matrix/crossSigning.ts` — the `ensureCrossSigning(client, homeserverUrl, accessToken)` helper. Called from `adapter.ts start()` after `client.start()` completes.
- `src/channels/matrix/runtime.ts` — `ensureMatrixCryptoUpToDate()` detects pre-0.5.0 bindings and forces a reinstall.
- `src/channels/pluginRegistry.ts` — pins `@matrix-org/matrix-sdk-crypto-nodejs@0.5.1` via `runtimeOverrides`.
- `src/channels/pluginTypes.ts` — `runtimeOverrides` field on `ChannelPluginMetadata`.
- `src/channels/runtimeDeps.ts` — emits `overrides` + `resolutions` in the runtime package.json.

matrix-bot-sdk@0.8.0 does **not** expose cross-signing on its `CryptoClient`. `RustEngine.js` even hard-throws on `SignatureUpload` request types. We reach through a private field to the underlying Rust `OlmMachine`:

```ts
const machine = (client.crypto as any).engine.machine as OlmMachine;
```

## Three gotchas that cost real time

### 1. `@matrix-org/matrix-sdk-crypto-nodejs@0.4.x` silently drops the bootstrap result

The 0.4.0 binding declares `bootstrapCrossSigning(reset: boolean): Promise<void>`. The upstream Rust function actually returns a `CrossSigningBootstrapRequests` struct carrying the HS upload requests — the 0.4.0 napi binding drops the return value entirely. Keys get generated in the local sqlite store; there's no way to observe the requests from JS.

Fixed in **0.5.0** (released 2026-04-20): `bootstrapCrossSigning(reset): Promise<CrossSigningBootstrapRequests>`.

**matrix-bot-sdk@0.8.0 declares `^0.4.0` for the binding.** We override to `0.5.1` via `runtimeOverrides` (emitted as both npm `overrides` and yarn `resolutions` in the runtime manifest). Compatibility verified: same `RequestType` enum, same `OlmMachine.initialize` signature, same `CryptoClient.prepare` flow.

### 2. `SignatureUploadRequest.body` has a `signed_keys` wrapper the HTTP endpoint does NOT want

The binding's body looks like:

```json
{
  "signed_keys": {
    "@bot:server": {
      "DEVICEID": { "signatures": { ... }, ... }
    }
  }
}
```

…because that matches the Rust struct's internal field name. But `POST /_matrix/client/v3/keys/signatures/upload` expects the **inner map directly** — top-level keys must be user IDs. Posting verbatim returns 200 with a per-key failure:

```json
{
  "failures": {
    "signed_keys": {
      "@bot:server": {
        "status": 400,
        "errcode": "M_INVALID_PARAM",
        "message": "400: Expected UserID string to start with '@'"
      }
    }
  }
}
```

Silently breaks the device-signing step while the master/SSK/USK upload looks successful. **Always unwrap `signed_keys` before POSTing.**

### 3. `/keys/signatures/upload` returns 200 even on per-key failures

Non-empty `failures` map in the response body means nothing applied. Our old code only checked HTTP status and treated 200 as success, masking bug #2. The current helper throws when `failures` is non-empty.

## Idempotency design

`ensureCrossSigning` runs on every adapter start. We intentionally do NOT short-circuit when local `hasMaster && hasSelfSigning && hasUserSigning` are all true:

- `bootstrapCrossSigning(false)` with existing local keys is cheap — it reads state and returns the upload requests, doesn't regenerate keys.
- Synapse short-circuits identical master/SSK/USK uploads as 200 OK with no UIA (confirmed in `synapse/rest/client/keys.py`: `if not keys_are_different: return 200, {}`).
- Signatures upload is no-op on already-applied signatures.
- If a prior start partial-failed (keys uploaded but signatures rejected due to bug #2), re-running fixes it.

## UIA and MAS

First-time upload of cross-signing keys to `/keys/device_signing/upload` does NOT require UIA per MSC3967, confirmed in Synapse source:

```python
# The keys are different; is x-signing set up? If no, then this is first-time
# setup, and that is allowed without UIA, per MSC3967.
```

**Subsequent resets (replacing existing keys) DO require UIA.** Under MAS, password UIA isn't available — Synapse returns a 401 pointing at the account-management OAuth URL with `action=org.matrix.cross_signing_reset`. There's no headless path for a bot to complete this; it's a browser flow for a human.

Practical implication: if a bot account already has a cross-signing identity bootstrapped by another client (e.g. someone logged in via Element Web first), the bot cannot replace it from code. The master key's private half lives only wherever it was originally bootstrapped.

## Pre-existing cross-signing identity

We hit this during initial debugging: `@tracebot` had been logged into via Element on Firefox, which bootstrapped cross-signing with keys only Firefox had. The bot's fresh crypto store couldn't reconcile — `bootstrap_cross_signing` locally generates new private keys that don't match the server's public keys.

Options when this happens:
1. **Manual verification from the existing client** (Element Web/Desktop with the original keys) — find the bot's device in the session list, click "Verify". The existing SSK signs the bot device.
2. **Reset cross-signing via MAS OAuth** — browser flow at the account-management URL. Invalidates all existing signed relationships.
3. **Fresh account** — simplest if the bot hasn't started being used.

`ensureCrossSigning` detects the "already-bootstrapped locally" case and returns early, but **does not detect the server-side mismatch**. A future improvement would be to query `/keys/query` for our own device and confirm the SSK signature is present; if not, log a clear "manual verification required" message.

## Debugging runbook

### Is cross-signing actually applied on the server?

```bash
TOKEN=<bot access token>
USER_ID="@bot:server"

curl -sS -X POST https://homeserver/_matrix/client/v3/keys/query \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"device_keys\":{\"$USER_ID\":[]}}" | jq '{
    master_key: .master_keys["'$USER_ID'"].keys,
    self_signing_key: .self_signing_keys["'$USER_ID'"].keys,
    user_signing_key: .user_signing_keys["'$USER_ID'"].keys,
    device_sigs: (.device_keys["'$USER_ID'"] | to_entries | map({
      device_id: .key,
      signed_by: (.value.signatures["'$USER_ID'"] | keys)
    }))
  }'
```

- `master_key`/`self_signing_key`/`user_signing_key` all null → cross-signing never bootstrapped.
- `signed_by` for the bot device contains only `ed25519:<device_id>` → master keys uploaded but device not signed by SSK (bug #2 or partial failure).
- `signed_by` contains both `ed25519:<device_id>` and `ed25519:<self_signing_key_id>` → fully good, Element X will show green shield.

### What does the Rust binding see locally?

Short Bun script against the bot's crypto store (use a `cp -a` copy while the bot runs to avoid sqlite lock contention):

```js
const { MatrixClient, SimpleFsStorageProvider, RustSdkCryptoStorageProvider } =
  require("matrix-bot-sdk");
const cryptoMod = require("@matrix-org/matrix-sdk-crypto-nodejs");
const storeValue = cryptoMod.StoreType?.Sqlite ?? 0;

const client = new MatrixClient(homeserverUrl, accessToken,
  new SimpleFsStorageProvider(`${probeDir}/storage.json`),
  new RustSdkCryptoStorageProvider(`${probeDir}/crypto`, storeValue));
await client.crypto.prepare([]);

const machine = client.crypto.engine.machine;
const status = await machine.crossSigningStatus();
console.log(status.hasMaster, status.hasSelfSigning, status.hasUserSigning);

const reqs = await machine.bootstrapCrossSigning(false);
console.log("sig body:", JSON.parse(reqs.uploadSignaturesReq.body));
```

### Bundle vs source mismatch on cypher (Argos-style deployments)

Argos installs `@letta-ai/letta-code` from `github:snowctl/letta-code` via npm. Its `package-lock.json` pins a specific commit SHA — if that's old, `npm install` reinstalls the old bundle and overwrites any hand-swapped `letta.js`.

To pin the current fork HEAD:
```bash
cd ~/Argos/middleware && npm install "github:snowctl/letta-code" --save
```

To verify the running bundle has our code:
```bash
grep -c "ensureCrossSigning\|CrossSigningBootstrapRequests\|signed_keys" \
  ~/Argos/middleware/node_modules/@letta-ai/letta-code/letta.js
```

Expect ≥3; 0 means the bundle is stale.

## Key file paths at runtime (on cypher / similar deployments)

- `~/.letta/channels/matrix/accounts.json` — account configs, includes `accessToken`, `accountId`, `e2ee`.
- `~/.letta/channels/matrix/<accountId>/crypto/matrix-sdk-crypto.sqlite3` — the bot's crypto store (includes private cross-signing keys once bootstrapped). **Back this up.** Losing it means the bot gets a new device and needs to re-bootstrap / be re-verified.
- `~/.letta/channels/matrix/runtime/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/package.json` — installed version. Must be ≥ 0.5.0.

## Related reading

- MSC3967: first-time cross-signing upload without UIA
- MSC3861 / MAS: OAuth-based auth delegation (impacts UIA for reset flows)
- matrix-rust-sdk `bootstrap_cross_signing` — upstream Rust function we reach through
- Synapse source: `rest/client/keys.py::SigningKeyUploadServlet::on_POST` — the auth logic for `/keys/device_signing/upload`
