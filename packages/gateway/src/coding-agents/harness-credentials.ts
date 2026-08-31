import type { ProviderHarnessKind, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import {
  buildKernelCredentialLaunch,
  KernelCredentialAccessSourceIdSchema,
  type KernelCredentialAccessSourceId,
  type KernelCredentialLaunch,
} from "../kernel-credentials.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";

const PORTABLE_CREDENTIAL_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;
const SAFE_ERROR = "Selected coding harness access is unavailable";

export interface CodingHarnessCredentialLaunch {
  env: Record<string, string>;
  maxRunMs?: number;
}

export type CodingHarnessCredentialResolver = (
  signal?: AbortSignal,
) => Promise<CodingHarnessCredentialLaunch>;

type CredentialLaunchFn = (
  homePath: string,
  baseEnv: NodeJS.ProcessEnv,
  requestedAccessSourceId?: KernelCredentialAccessSourceId,
  fundedProvider?: MatrixFundedCredentialProvider,
) => Promise<KernelCredentialLaunch>;

interface HarnessSettingsReader {
  getSnapshot(): Promise<ProviderSettingsSnapshot>;
}

function portableEnvironment(value: Record<string, string | undefined> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PORTABLE_CREDENTIAL_KEYS) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.length > 0) env[key] = candidate;
  }
  return env;
}

export function createCodingHarnessCredentialResolver(options: {
  harness: Extract<ProviderHarnessKind, "pi" | "opencode">;
  homePath: string;
  settings: HarnessSettingsReader;
  baseEnv?: NodeJS.ProcessEnv;
  fundedProvider?: MatrixFundedCredentialProvider;
  resolveCredentialLaunch?: CredentialLaunchFn;
}): CodingHarnessCredentialResolver {
  const resolveCredentialLaunch = options.resolveCredentialLaunch ?? buildKernelCredentialLaunch;
  const baseEnv = options.baseEnv ?? process.env;

  return async (signal) => {
    signal?.throwIfAborted();
    const snapshot = await options.settings.getSnapshot();
    const enabled = snapshot.harnesses.filter(
      (candidate) => candidate.harness === options.harness && candidate.enabled,
    );
    if (enabled.length !== 1) throw new Error(SAFE_ERROR);
    const harness = enabled[0]!;
    if (harness.authState !== "authenticated"
      || harness.connectivity !== "online"
      || harness.route.providerId !== "anthropic") {
      throw new Error(SAFE_ERROR);
    }
    const parsedSource = KernelCredentialAccessSourceIdSchema.safeParse(harness.accessSourceId);
    // Claude's OAuth profile is consumed by Claude Code/Agent SDK and is not a
    // portable provider credential. Never pretend it can authenticate another CLI.
    if (!parsedSource.success || parsedSource.data === "owner_anthropic_profile") {
      throw new Error(SAFE_ERROR);
    }
    const launch = await resolveCredentialLaunch(
      options.homePath,
      baseEnv,
      parsedSource.data,
      options.fundedProvider,
    );
    signal?.throwIfAborted();
    const env = portableEnvironment(launch.env);
    if (!env.ANTHROPIC_API_KEY) throw new Error(SAFE_ERROR);
    return {
      env,
      ...(launch.fundedRunTimeoutMs ? { maxRunMs: launch.fundedRunTimeoutMs } : {}),
    };
  };
}
