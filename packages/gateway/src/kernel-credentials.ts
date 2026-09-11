import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type {
  FundedAiCredentialLease,
  MatrixFundedCredentialProvider,
} from "./funded-ai-credential-manager.js";

export type KernelCredentialMode = "platform" | "api_key" | "claude_login";
export const KernelCredentialAccessSourceIdSchema = z.enum([
  "matrix_included",
  "owner_anthropic_key",
  "owner_anthropic_profile",
]);
export type KernelCredentialAccessSourceId = z.infer<typeof KernelCredentialAccessSourceIdSchema>;
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
  fundedRunTimeoutMs?: number;
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

function applyFundedCredential(
  env: Record<string, string | undefined>,
  lease: FundedAiCredentialLease,
): void {
  env.ANTHROPIC_API_KEY = lease.token;
  env.ANTHROPIC_BASE_URL = lease.relayBaseUrl;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.MATRIX_AUTH_TOKEN;
  delete env.UPGRADE_TOKEN;
  delete env.MATRIX_CODE_PROXY_TOKEN;
  delete env.AI_RELAY_CONTROL_TOKEN;
  delete env.CF_AIG_AUTHORIZATION;
}

async function resolveKernelCredentials(
  homePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  requestedAccessSourceId?: KernelCredentialAccessSourceId,
  fundedProvider?: MatrixFundedCredentialProvider,
  acquireFundedCredential = true,
): Promise<KernelCredentialResolution> {
  const env = { ...baseEnv };
  const matrixState = fundedProvider?.enabled ? "ready" as const : "disabled" as const;
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

  if (requestedAccessSourceId === "matrix_included") {
    if (!fundedProvider) throw new Error("Selected AI access is unavailable");
    const lease = await fundedProvider.getCredential();
    applyFundedCredential(env, lease);
    return { mode: "platform", env, sources, fundedRunTimeoutMs: lease.maxRunMs };
  }
  if (requestedAccessSourceId === "owner_anthropic_key") {
    if (ownerApiKey === undefined) throw new Error("Selected AI access is unavailable");
    env.ANTHROPIC_API_KEY = ownerApiKey;
    delete env.ANTHROPIC_BASE_URL;
    return { mode: "api_key", env, sources };
  }
  if (requestedAccessSourceId === "owner_anthropic_profile") {
    if (!hasOwnerProfile) throw new Error("Selected AI access is unavailable");
    env.HOME = homePath;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
    return { mode: "claude_login", env, sources };
  }

  if (ownerApiKey !== undefined) {
    env.ANTHROPIC_API_KEY = ownerApiKey;
    delete env.ANTHROPIC_BASE_URL;
    return { mode: selectedMode, env, sources };
  }
  if (hasOwnerProfile) {
    env.HOME = homePath;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
    return { mode: selectedMode, env, sources };
  }
  if (fundedProvider && acquireFundedCredential) {
    const lease = await fundedProvider.getCredential();
    applyFundedCredential(env, lease);
    return { mode: selectedMode, env, sources, fundedRunTimeoutMs: lease.maxRunMs };
  }
  return { mode: selectedMode, sources };
}

export interface KernelCredentialLaunch {
  env?: Record<string, string | undefined>;
  fundedRunTimeoutMs?: number;
}

export async function buildKernelCredentialLaunch(
  homePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  requestedAccessSourceId?: KernelCredentialAccessSourceId,
  fundedProvider?: MatrixFundedCredentialProvider,
): Promise<KernelCredentialLaunch> {
  const resolved = await resolveKernelCredentials(
    homePath,
    baseEnv,
    requestedAccessSourceId,
    fundedProvider,
  );
  return { env: resolved.env, fundedRunTimeoutMs: resolved.fundedRunTimeoutMs };
}

export async function buildKernelEnv(
  homePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  requestedAccessSourceId?: KernelCredentialAccessSourceId,
  fundedProvider?: MatrixFundedCredentialProvider,
): Promise<Record<string, string | undefined> | undefined> {
  return (await buildKernelCredentialLaunch(
    homePath,
    baseEnv,
    requestedAccessSourceId,
    fundedProvider,
  )).env;
}

export async function resolveKernelCredentialMode(homePath: string): Promise<KernelCredentialMode> {
  return (await resolveKernelCredentials(homePath)).mode;
}

export async function resolveKernelCredentialSources(
  homePath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  fundedProvider?: MatrixFundedCredentialProvider,
): Promise<KernelCredentialSources> {
  return (await resolveKernelCredentials(
    homePath,
    baseEnv,
    undefined,
    fundedProvider,
    false,
  )).sources;
}
