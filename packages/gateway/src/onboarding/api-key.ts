import { createOwnerAnthropicKeySaver, readOwnerAnthropicKey } from "../ai-providers/owner-anthropic-key.js";
import { createNativeProviderWriterLease } from "../ai-providers/native-provider-writer-lease.js";
import { NativeProviderWriteNotStartedError, NativeProviderWriteRestoredError, type NativeProviderProfileGuard } from "../ai-providers/native-provider-profile-guard.js";

export function validateApiKeyFormat(key: string): { valid: true } | { valid: false; error: string } {
  if (!key || !key.startsWith("sk-ant-")) {
    return { valid: false, error: "Key must start with sk-ant-" };
  }
  return { valid: true };
}

export async function validateApiKeyLive(key: string): Promise<{ valid: true } | { valid: false; error: string }> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) return { valid: true };
    console.error(`[api-key] Validation returned HTTP ${res.status}`);
    return { valid: false, error: "Key validation failed" };
  } catch (err) {
    const msg = err instanceof Error ? err.message.replace(/sk-ant-[a-zA-Z0-9_-]+/g, "[REDACTED]") : "Unknown error";
    console.error(`[api-key] Validation error: ${msg}`);
    return { valid: false, error: "Key validation failed" };
  }
}

/** Legacy onboarding and Settings share the owner workflow credential and writer fence. */
export async function storeApiKey(homePath: string, apiKey: string, profileGuard?: NativeProviderProfileGuard): Promise<void> {
  const save = () => createOwnerAnthropicKeySaver({ homePath })(apiKey);
  if (profileGuard) return profileGuard.run("claude", { kind: "write", durable: true }, save);
  const release = await createNativeProviderWriterLease(homePath).acquire("claude");
  try { await save(); await release(); }
  catch (error) {
    if (error instanceof NativeProviderWriteNotStartedError || error instanceof NativeProviderWriteRestoredError) await release();
    throw error;
  }
}

/** Ambient operator credentials never describe this owner's connected source. */
export async function hasApiKey(homePath: string): Promise<boolean> {
  const source = await readOwnerAnthropicKey(homePath);
  return source.state === "unverified" && source.key !== undefined;
}
