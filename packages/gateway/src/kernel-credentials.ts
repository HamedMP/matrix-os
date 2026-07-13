import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type KernelCredentialMode = "platform" | "api_key" | "claude_login";

interface KernelCredentialResolution {
  mode: KernelCredentialMode;
  env?: Record<string, string | undefined>;
}

function hasClaudeOauthConfig(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const account = (value as { oauthAccount?: unknown }).oauthAccount;
  if (!account || typeof account !== "object") return false;
  return typeof (account as { accountUuid?: unknown }).accountUuid === "string";
}

function logCredentialReadFailure(label: string, err: unknown): void {
  console.warn(label, err instanceof Error ? err.message : String(err));
}

async function resolveKernelCredentials(
  homePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<KernelCredentialResolution> {
  const env = { ...baseEnv };
  try {
    const raw = await readFile(join(homePath, "system/config.json"), "utf-8");
    const userConfig = JSON.parse(raw);
    const byokKey = userConfig?.kernel?.anthropicApiKey;
    if (byokKey && typeof byokKey === "string") {
      env.ANTHROPIC_API_KEY = byokKey;
      return { mode: "api_key", env };
    }
  } catch (err) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      logCredentialReadFailure("[kernel-credentials] failed to read user API key config:", err);
    }
  }

  try {
    const raw = await readFile(join(homePath, ".claude.json"), "utf-8");
    if (hasClaudeOauthConfig(JSON.parse(raw))) {
      env.HOME = homePath;
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_BASE_URL;
      return { mode: "claude_login", env };
    }
  } catch (err) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      logCredentialReadFailure("[kernel-credentials] failed to read Claude OAuth config:", err);
    }
  }

  return { mode: "platform" };
}

export async function buildKernelEnv(
  homePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string | undefined> | undefined> {
  return (await resolveKernelCredentials(homePath, baseEnv)).env;
}

export async function resolveKernelCredentialMode(homePath: string): Promise<KernelCredentialMode> {
  return (await resolveKernelCredentials(homePath)).mode;
}
