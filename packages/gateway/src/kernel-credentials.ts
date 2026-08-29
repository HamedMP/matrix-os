import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type KernelCredentialMode = "platform" | "api_key" | "claude_login";
export type KernelCredentialAccessSourceId =
  | "matrix_included"
  | "owner_anthropic_key"
  | "owner_anthropic_profile";
export type KernelCredentialObservationState =
  | "ready"
  | "setup_required"
  | "unverified"
  | "invalid"
  | "unavailable"
  | "disabled";

export interface KernelCredentialSources {
  selectedMode: KernelCredentialMode;
  selectedAccessSourceId: KernelCredentialAccessSourceId;
  matrixIncluded: { state: KernelCredentialObservationState };
  ownerApiKey: { state: KernelCredentialObservationState };
  ownerProfile: { state: KernelCredentialObservationState };
}

interface KernelCredentialResolution {
  mode: KernelCredentialMode;
  env?: Record<string, string | undefined>;
  sources: KernelCredentialSources;
}

function hasClaudeOauthConfig(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const account = (value as { oauthAccount?: unknown }).oauthAccount;
  if (!account || typeof account !== "object") return false;
  return typeof (account as { accountUuid?: unknown }).accountUuid === "string";
}

function logCredentialReadFailure(label: string, err: unknown): void {
  console.warn(label, err instanceof Error ? err.name : "UnknownError");
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function observationForReadFailure(err: unknown): KernelCredentialObservationState {
  return err instanceof SyntaxError ? "invalid" : "unavailable";
}

async function resolveKernelCredentials(
  homePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<KernelCredentialResolution> {
  const env = { ...baseEnv };
  const matrixState = typeof baseEnv.ANTHROPIC_API_KEY === "string"
    && baseEnv.ANTHROPIC_API_KEY.trim().length > 0
    ? "ready" as const
    : "disabled" as const;
  let apiKeyState: KernelCredentialObservationState = "setup_required";
  let profileState: KernelCredentialObservationState = "setup_required";
  let ownerApiKey: string | undefined;
  let hasOwnerProfile = false;

  try {
    const raw = await readFile(join(homePath, "system/config.json"), "utf-8");
    const userConfig = JSON.parse(raw);
    const byokKey = userConfig?.kernel?.anthropicApiKey;
    if (typeof byokKey === "string" && byokKey.trim().length > 0) {
      ownerApiKey = byokKey;
      apiKeyState = "unverified";
    }
  } catch (err) {
    if (!isNotFound(err)) {
      apiKeyState = observationForReadFailure(err);
      logCredentialReadFailure("[kernel-credentials] failed to read user API key config:", err);
    }
  }

  try {
    const raw = await readFile(join(homePath, ".claude.json"), "utf-8");
    if (hasClaudeOauthConfig(JSON.parse(raw))) {
      hasOwnerProfile = true;
      profileState = "unverified";
    }
  } catch (err) {
    if (!isNotFound(err)) {
      profileState = observationForReadFailure(err);
      logCredentialReadFailure("[kernel-credentials] failed to read Claude OAuth config:", err);
    }
  }

  const selectedMode: KernelCredentialMode = ownerApiKey !== undefined
    ? "api_key"
    : hasOwnerProfile
      ? "claude_login"
      : "platform";
  const selectedAccessSourceId: KernelCredentialAccessSourceId = selectedMode === "api_key"
    ? "owner_anthropic_key"
    : selectedMode === "claude_login"
      ? "owner_anthropic_profile"
      : "matrix_included";
  const sources: KernelCredentialSources = {
    selectedMode,
    selectedAccessSourceId,
    matrixIncluded: { state: matrixState },
    ownerApiKey: { state: apiKeyState },
    ownerProfile: { state: profileState },
  };

  if (ownerApiKey !== undefined) {
    env.ANTHROPIC_API_KEY = ownerApiKey;
    return { mode: selectedMode, env, sources };
  }
  if (hasOwnerProfile) {
    env.HOME = homePath;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
    return { mode: selectedMode, env, sources };
  }
  return { mode: selectedMode, sources };
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

export async function resolveKernelCredentialSources(
  homePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<KernelCredentialSources> {
  return (await resolveKernelCredentials(homePath, baseEnv)).sources;
}
