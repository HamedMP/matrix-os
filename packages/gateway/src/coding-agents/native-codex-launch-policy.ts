import type { AgentLaunchInput } from "../agent-launcher.js";
import { codexNativeEnvironment } from "../ai-providers/codex-native-environment.js";

export interface NativeCodexSubscriptionLaunch {
  codexHome: string;
  expectedPrincipalFingerprint: string;
  expectedConsentRevision: number;
  expectedConfigurationFingerprint: string;
  expectedHarnessInstanceId: string;
  expectedAccountId: string;
}

/** Keep policy out of the launcher composition entrypoint. Codex 0.156.1's
 * built-in openai provider is not replaceable through model_providers. CLI
 * overrides neutralize profile/project routing; runtime readback additionally
 * rejects managed provider requirements that outrank those overrides. */
export function nativeCodexLaunchPolicy(input: AgentLaunchInput, environment: Record<string, string>) {
  if (input.agent !== "codex" || !input.runtimeHome || !input.providerEventPath || !input.nativeCodexSubscription
    || !/^[a-f0-9]{64}$/.test(input.nativeCodexSubscription.expectedPrincipalFingerprint)
    || !/^[a-f0-9]{64}$/.test(input.nativeCodexSubscription.expectedConfigurationFingerprint)
    || !Number.isSafeInteger(input.nativeCodexSubscription.expectedConsentRevision) || input.nativeCodexSubscription.expectedConsentRevision < 0
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.nativeCodexSubscription.expectedHarnessInstanceId)
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.nativeCodexSubscription.expectedAccountId)
    || (input.model && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.model))) {
    throw new Error("Native Codex execution is unavailable");
  }
  const env = codexNativeEnvironment(input.runtimeHome, environment, input.nativeCodexSubscription.codexHome);
  // Preserve only the execution budgets already validated by the launcher.
  for (const [key, value] of Object.entries(environment)) {
    if (/^MATRIX_CODEX_(TOOL|COMMAND|NO_PROGRESS|TURN)_DEADLINE_MS$/.test(key)
      || key === "MATRIX_CODEX_NO_PROGRESS_MS") env[key] = value;
  }
  return {
    env,
    args: [
      "-c", 'forced_login_method="chatgpt"',
      "-c", 'model_provider="openai"',
      "-c", 'openai_base_url=""',
      "-c", 'chatgpt_base_url="https://chatgpt.com/backend-api/"',
    ],
  };
}
