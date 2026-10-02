import {
  buildKernelCredentialLaunch,
  type KernelCredentialAccessSourceId,
  type KernelCredentialLaunch,
  type KernelFundingContext,
} from "../kernel-credentials.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";

/** Gateway-only injection for the owned Pi broker; never a worker environment. */
export async function resolveBotBrokerCredentials(
  homePath: string,
  baseEnv: NodeJS.ProcessEnv,
  accessSourceId: KernelCredentialAccessSourceId | undefined,
  provider: MatrixFundedCredentialProvider | undefined,
  funding: KernelFundingContext,
  signal?: AbortSignal,
): Promise<KernelCredentialLaunch> {
  if (accessSourceId !== "matrix_included") {
    return buildKernelCredentialLaunch(homePath, baseEnv, accessSourceId, provider, funding);
  }
  if (!provider?.enabled) throw new Error("Selected AI access is unavailable");
  const lease = await provider.getCredential({ requestClass: funding.requestClass, ...(signal ? { signal } : {}) });
  return {
    env: { ANTHROPIC_AUTH_TOKEN: lease.token, ANTHROPIC_BASE_URL: lease.relayBaseUrl },
    fundedRunTimeoutMs: lease.maxRunMs,
  };
}
