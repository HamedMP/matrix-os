import { loadSkills } from "@matrix-os/kernel";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";
import { buildKernelCredentialLaunch } from "../kernel-credentials.js";
import { type MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import { createRuntimeClaudeModelCatalogSource } from "./claude-runtime-model-catalog.js";
import { createCodexModelCatalogSource } from "./codex-model-catalog.js";
import { createNativeCodingModelCatalogSource } from "./native-coding-model-catalog.js";
import { createChatProviderCatalogService } from "./provider-catalog.js";

type RuntimeCatalogOptions = Omit<Parameters<typeof createChatProviderCatalogService>[0],
  "skillsSource" | "codingModelCatalogSource" | "invalidateCodingModelCatalog"> & {
  homePath: string;
  codexExecutable?: string;
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
};

/** Compose runtime metadata sources separately from the gateway entrypoint. */
export function createGatewayChatProviderCatalog(options: RuntimeCatalogOptions) {
  const { homePath, codexExecutable, fundedCredentialProvider, ...catalogOptions } = options;
  const codexModelCatalogSource = codexExecutable
    ? createCodexModelCatalogSource({
      executable: codexExecutable,
      cwd: homePath,
      environment: buildAgentRuntimeEnvironment(homePath),
    })
    : undefined;
  const nativeCodingModelCatalogSource = createNativeCodingModelCatalogSource({ homePath });
  const resolveClaudeCredentialLaunch = async (context?: { runId: string; instanceId?: string }) => {
    // Retired funded selections must never acquire a lease or fall back to a
    // different billing source. Existing transcripts and profiles stay intact.
    if (context?.instanceId === "claude_code_matrix_included") {
      throw new Error("Selected AI access is unavailable");
    }
    const settings = await catalogOptions.harnessSettingsSource?.getSnapshot({ suppressFundedProbes: true });
    const claude = settings?.harnesses.filter(row => row.harness === "claude" && row.id !== "harness_kernel") ?? [];
    const native = claude.filter(row => row.configuredAccessSourceId === "owner_claude_profile"
      || row.accessSourceId === "owner_claude_profile" || row.selectedAccountId === "owner_claude_profile");
    const ownerKey = claude.filter(row => row.configuredAccessSourceId === "owner_anthropic_key"
      || row.accessSourceId === "owner_anthropic_key");
    if (native.length === 0 && ownerKey.length > 0) {
      // The owner's explicitly selected Anthropic key; never a funded or ambient credential.
      const enabled = claude.filter(row => row.configuredEnabled ?? row.enabled);
      const row = ownerKey[0];
      const source = settings!.accessSources.find(source => source.id === "owner_anthropic_key");
      const account = settings!.accounts.find(account => account.id === source?.accountId);
      if (ownerKey.length !== 1 || enabled.length !== 1 || enabled[0] !== row
        || row.installState !== "installed" || row.accessSourceId !== "owner_anthropic_key"
        || (row.configuredAccessSourceId !== undefined && row.configuredAccessSourceId !== "owner_anthropic_key")
        || row.selectedAccountId !== "owner_anthropic"
        || row.route.providerId !== "anthropic" || row.routeAvailability === "catalog_unavailable"
        || source?.kind !== "provider_account" || source.fundingKind !== "owner_api_key"
        || source.providerId !== "anthropic" || source.accountId !== "owner_anthropic"
        || !source.eligibleModelIds.includes(row.route.modelId)
        || account?.providerId !== "anthropic" || account.authMethod !== "api_key"
        || account.accessSourceId !== "owner_anthropic_key") {
        throw new Error("Selected AI access is unavailable");
      }
      // No funded provider: the owner key route can never reach Matrix AI funding.
      return buildKernelCredentialLaunch(
        homePath, buildAgentRuntimeEnvironment(homePath), "owner_anthropic_key", undefined,
        { requestClass: "interactive", ...(context ? { claimKey: context.runId } : {}) },
      );
    }
    if (claude.length > 0 && native.length === 0) throw new Error("Selected AI access is unavailable");
    if (native.length > 0) {
      const enabled = claude.filter(row => row.configuredEnabled ?? row.enabled);
      const row = native[0];
      const source = settings!.accessSources.find(source => source.id === "owner_claude_profile");
      const account = settings!.accounts.find(account => account.id === "owner_claude_profile");
      if (native.length !== 1 || enabled.length !== 1 || enabled[0] !== row
        || row.installState !== "installed" || row.accessSourceId !== "owner_claude_profile"
        || (row.configuredAccessSourceId !== undefined && row.configuredAccessSourceId !== "owner_claude_profile")
        || row.selectedAccountId !== "owner_claude_profile" || !row.accountIds.includes("owner_claude_profile")
        || row.route.providerId !== "anthropic" || row.routeAvailability === "catalog_unavailable"
        || source?.kind !== "provider_account" || source.fundingKind !== "owner_account"
        || source.providerId !== "anthropic" || source.accountId !== "owner_claude_profile"
        || !source.eligibleModelIds.includes(row.route.modelId)
        || account?.providerId !== "anthropic" || account.authMethod !== "terminal"
        || account.accessSourceId !== "owner_claude_profile") {
        throw new Error("Selected AI access is unavailable");
      }
    }
    return buildKernelCredentialLaunch(
      homePath, buildAgentRuntimeEnvironment(homePath), "owner_claude_profile", fundedCredentialProvider,
      { requestClass: "interactive", ...(context ? { claimKey: context.runId } : {}) },
    );
  };
  const claudeModelCatalogSource = createRuntimeClaudeModelCatalogSource({
    homePath, resolveCredentialLaunch: resolveClaudeCredentialLaunch,
  });
  const catalog = createChatProviderCatalogService({
    ...catalogOptions,
    skillsSource: () => loadSkills(homePath),
    invalidateCodingModelCatalog: claudeModelCatalogSource.invalidate,
    codingModelCatalogSource: async (provider, principal) => {
      const claudeModels = await claudeModelCatalogSource(provider, principal);
      if (claudeModels) return claudeModels;
      const codexModels = await codexModelCatalogSource?.(provider);
      return codexModels ?? nativeCodingModelCatalogSource(provider);
    },
  });
  // Execution and metadata discovery must resolve the same owner credentials.
  return { catalog, resolveClaudeCredentialLaunch };
}
