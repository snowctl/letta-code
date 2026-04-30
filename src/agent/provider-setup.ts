import { debugWarn } from "../utils/debug";
import { getClient } from "./client";

type Provider = {
  id: string;
  name: string;
  provider_type: string;
  base_url?: string | null;
  provider_category?: "base" | "byok" | null;
  last_synced?: string | null;
};

/**
 * Ensure the openai-compatible proxy provider is registered and has LLM models
 * synced. Called once at startup. Errors are logged but never thrown.
 *
 * This avoids the corruption that `PATCH /v1/providers/{id}/refresh` causes
 * on every `!models` invocation (Letta soft-deletes models not in the current
 * API response; once soft-deleted they can never be re-created due to a unique
 * constraint bug in letta-server).
 */
export async function ensureOpenAIProxyProvider(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;

  if (!apiKey || !baseUrl) {
    return;
  }

  try {
    const client = await getClient();

    const providers = await client.get<Provider[]>("/v1/providers/");
    const existing = providers.find(
      (p) => p.provider_category === "byok" && p.base_url === baseUrl,
    );

    let providerId: string;

    if (!existing) {
      const created = await client.post<Provider>("/v1/providers/", {
        body: {
          name: "openai-proxy",
          provider_type: "openai",
          base_url: baseUrl,
          api_key: apiKey,
        },
      });
      providerId = created.id;
    } else {
      providerId = existing.id;
    }

    // Check if this provider already has LLM models available.
    type Model = { handle?: string | null; model_type?: string | null };
    const models = await client.get<Model[]>(`/v1/models/`);
    const hasProxyModels = models.some((m) =>
      m.handle?.startsWith("openai-proxy/"),
    );

    if (!hasProxyModels) {
      // Trigger a one-time sync. This is the only place we call /refresh so
      // the dangerous "refresh on every !models" pattern is gone.
      await client.patch<Provider>(`/v1/providers/${providerId}/refresh`);
    }
  } catch (err) {
    debugWarn("provider-setup", "Failed to ensure openai-proxy provider:", err);
  }
}
