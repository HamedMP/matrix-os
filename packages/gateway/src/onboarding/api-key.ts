import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

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

export async function storeApiKey(homePath: string, apiKey: string): Promise<void> {
  const configPath = join(homePath, "system", "config.json");
  let config: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error("[api-key] Failed to read config:", (err as Error).message);
    }
  }
  const kernel = (config.kernel as Record<string, unknown>) ?? {};
  kernel.anthropicApiKey = apiKey;
  config.kernel = kernel;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

export async function hasApiKey(homePath: string): Promise<boolean> {
  // Check env var first (set in Docker/.env)
  if (process.env.ANTHROPIC_API_KEY) return true;
  try {
    const raw = await readFile(join(homePath, "system", "config.json"), "utf-8");
    const config = JSON.parse(raw);
    return Boolean(config?.kernel?.anthropicApiKey);
  } catch {
    return false;
  }
}
