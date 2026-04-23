// src/channels/matrix/setup.ts
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { upsertChannelAccount } from "../accounts";
import type { DmPolicy, MatrixChannelAccount } from "../types";
import {
  ensureMatrixRuntimeInstalled,
  loadMatrixBotSdkModule,
} from "./runtime";

function parseBytesString(input: string): number {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(mb|gb|kb)?$/);
  if (!match) return 50 * 1024 * 1024;
  const value = parseFloat(match[1]!);
  const unit = match[2] ?? "mb";
  if (unit === "gb") return Math.floor(value * 1024 * 1024 * 1024);
  if (unit === "kb") return Math.floor(value * 1024);
  return Math.floor(value * 1024 * 1024);
}

async function validateMatrixToken(
  homeserverUrl: string,
  accessToken: string,
): Promise<{ userId: string }> {
  const url = `${homeserverUrl.replace(/\/$/, "")}/_matrix/client/v3/account/whoami`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as { user_id: string };
  if (!data.user_id) throw new Error("No user_id in whoami response");
  return { userId: data.user_id };
}

export async function runMatrixSetup(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("\n🔷 Matrix Bot Setup\n");

    await ensureMatrixRuntimeInstalled();

    // Step 1: Homeserver URL
    const homeserverInput = await rl.question(
      "Homeserver URL (e.g. https://matrix.example.com): ",
    );
    const homeserverUrl = homeserverInput.trim().replace(/\/$/, "");
    if (!homeserverUrl) {
      console.error("No homeserver URL provided. Setup cancelled.");
      return false;
    }

    // Validate reachability
    console.log("\nChecking homeserver...");
    try {
      const r = await fetch(`${homeserverUrl}/_matrix/client/versions`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      console.log("✓ Homeserver reachable\n");
    } catch (err) {
      console.error(
        `✗ Cannot reach homeserver: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }

    // Step 2: User ID
    const userIdInput = await rl.question(
      "Bot Matrix user ID (e.g. @letta-bot:example.com): ",
    );
    const userId = userIdInput.trim();
    if (!userId.startsWith("@") || !userId.includes(":")) {
      console.error(
        "Invalid user ID. Must be in the form @username:server. Setup cancelled.",
      );
      return false;
    }

    // Step 3: Access token
    console.log("\nGenerate a compatibility token with:");
    console.log(
      "  mas-cli manage issue-compatibility-token " +
        userId.split(":")[0]?.slice(1),
    );
    console.log("(Run this on your Synapse server)\n");

    const tokenInput = await rl.question("Access token: ");
    const accessToken = tokenInput.trim();
    if (!accessToken) {
      console.error("No access token provided. Setup cancelled.");
      return false;
    }

    // Validate token
    console.log("\nValidating access token...");
    let validatedUserId: string;
    try {
      const info = await validateMatrixToken(homeserverUrl, accessToken);
      validatedUserId = info.userId;
      if (validatedUserId !== userId) {
        console.warn(
          `⚠ Token belongs to ${validatedUserId}, expected ${userId}. Continuing with ${validatedUserId}.`,
        );
      }
      console.log(`✓ Authenticated as ${validatedUserId}\n`);
    } catch (err) {
      console.error(
        `✗ Invalid token: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }

    // Step 4: DM policy
    console.log("DM Policy — who can message this bot?\n");
    console.log("  pairing   — Users must pair with a code (recommended)");
    console.log("  allowlist — Only pre-approved Matrix user IDs");
    console.log("  open      — Anyone can message\n");

    const policyInput = await rl.question("DM policy [pairing]: ");
    const policy = (policyInput.trim() || "pairing") as DmPolicy;
    if (!["pairing", "allowlist", "open"].includes(policy)) {
      console.error(`Invalid policy "${policy}". Setup cancelled.`);
      return false;
    }

    let allowedUsers: string[] = [];
    if (policy === "allowlist") {
      const usersInput = await rl.question(
        "Allowed Matrix user IDs (comma-separated, e.g. @alice:example.com): ",
      );
      allowedUsers = usersInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // Step 5: E2EE
    console.log(
      "\nE2EE encrypts messages end-to-end. Requires the Rust crypto addon (best-effort under Bun).",
    );
    console.log("Testing crypto addon availability...");
    let e2eeAvailable = false;
    try {
      const { RustSdkCryptoStorageProvider } = await loadMatrixBotSdkModule();
      e2eeAvailable = typeof RustSdkCryptoStorageProvider === "function";
      console.log(
        e2eeAvailable
          ? "✓ Crypto addon available\n"
          : "✗ Crypto addon unavailable\n",
      );
    } catch {
      console.log("✗ Crypto addon unavailable\n");
    }

    let e2ee = false;
    if (e2eeAvailable) {
      const e2eeInput = await rl.question("Enable E2EE? [y/N]: ");
      e2ee = /^(y|yes)$/i.test(e2eeInput.trim());
    } else {
      console.log("Skipping E2EE (addon not available).");
    }

    // Step 6: Voice transcription
    const transcriptionInput = await rl.question(
      "\nAuto-transcribe voice memos when OPENAI_API_KEY is set? [y/N]: ",
    );
    const transcribeVoice = /^(y|yes)$/i.test(transcriptionInput.trim());

    // Step 7: Media download limit
    const maxBytesInput = await rl.question(
      "\nMax media download size [50mb]: ",
    );
    const maxMediaDownloadBytes = maxBytesInput.trim()
      ? parseBytesString(maxBytesInput)
      : 50 * 1024 * 1024;

    // Write account
    const now = new Date().toISOString();
    const account: MatrixChannelAccount = {
      channel: "matrix",
      accountId: randomUUID(),
      displayName: validatedUserId!,
      enabled: true,
      homeserverUrl,
      accessToken,
      userId: validatedUserId!,
      dmPolicy: policy,
      allowedUsers,
      e2ee,
      transcribeVoice,
      maxMediaDownloadBytes,
      createdAt: now,
      updatedAt: now,
    };

    upsertChannelAccount("matrix", account);
    console.log("\n✓ Matrix bot configured!");
    console.log("Config written to: ~/.letta/channels/matrix/accounts.json\n");
    console.log("Next steps:");
    console.log("  1. Start the listener: letta server --channels matrix");
    console.log("  2. Invite the bot to a Matrix room");
    console.log("  3. Send !start to get a pairing code");
    console.log(
      "  4. In the target ADE/Desktop conversation, run: /channels matrix pair <code>\n",
    );

    return true;
  } catch (error) {
    console.error(
      `Setup failed: ${error instanceof Error ? error.message : error}`,
    );
    return false;
  } finally {
    rl.close();
  }
}
