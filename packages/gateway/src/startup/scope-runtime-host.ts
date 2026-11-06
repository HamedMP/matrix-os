import { createDeploymentHost, resolveGatewayScopeRuntimeDeployment, type GatewayScopeRuntimeDeployment } from "../scope-runtime-host/deployment.js";
import type { ScopeRuntimeHost } from "../scope-runtime-host/index.js";
import type { FundedAdmissionQueue } from "../funded-ai/admission-queue.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";

/**
 * Starts the gateway's one scope-runtime host before collaboration, so
 * private bot runs work without it and shared AI registers on the same
 * broker socket. Namespaced configuration/constructor failures are terminal.
 */
export async function startScopeRuntimeHost(options: {
  homePath: string;
  deployment?: GatewayScopeRuntimeDeployment;
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
  fundedAdmission?: FundedAdmissionQueue;
  onFailure(context: string, error: unknown): void;
}): Promise<ScopeRuntimeHost | undefined> {
  const deployment = options.deployment ?? resolveGatewayScopeRuntimeDeployment(options.homePath);
  try {
    return await createDeploymentHost(options, deployment);
  } catch (error: unknown) {
    options.onFailure("Scope runtime host startup failed", error);
    if (deployment.config.namespace !== undefined) throw error;
    return undefined;
  }
}
