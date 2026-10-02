import type { FundedAdmissionQueue } from "../funded-ai/admission-queue.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import { BOT_SCOPE_RUNTIME_PROFILE_CATALOG } from "../bots/scope-runtime-profile.js";
import { MANAGED_PI_SCOPE_RUNTIME_PROFILE_CATALOG } from "../chat/managed-pi-profile.js";
import { SHARED_AI_PROFILE_CATALOG } from "../collaboration/shared-ai-runtime.js";
import { createScopeRuntimeHost, type ScopeRuntimeHost } from "../scope-runtime-host/index.js";

/**
 * Starts the gateway's one scope-runtime host before collaboration, so
 * private bot runs work without it and shared AI registers on the same
 * broker socket. A failure leaves the host absent; callers fall back.
 */
export async function startScopeRuntimeHost(options: {
  homePath: string;
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
  fundedAdmission?: FundedAdmissionQueue;
  onFailure(context: string, error: unknown): void;
}): Promise<ScopeRuntimeHost | undefined> {
  try {
    return await createScopeRuntimeHost({
      homePath: options.homePath,
      profileCatalog: { ...SHARED_AI_PROFILE_CATALOG, ...BOT_SCOPE_RUNTIME_PROFILE_CATALOG, ...MANAGED_PI_SCOPE_RUNTIME_PROFILE_CATALOG },
      ...(options.fundedCredentialProvider ? { fundedCredentialProvider: options.fundedCredentialProvider } : {}),
      ...(options.fundedAdmission ? { fundedAdmission: options.fundedAdmission } : {}),
    });
  } catch (error: unknown) {
    options.onFailure("Scope runtime host startup failed", error);
    return undefined;
  }
}
