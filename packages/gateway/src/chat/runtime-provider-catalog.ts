import { loadSkills } from "@matrix-os/kernel";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";
import { buildKernelCredentialLaunch } from "../kernel-credentials.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
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
    if (context?.instanceId === "claude_code_matrix_included") {
      return buildKernelCredentialLaunch(homePath, process.env, "matrix_included", fundedCredentialProvider,
        { requestClass: "interactive", claimKey: context.runId });
    }
    // Native execution and discovery have no harness-instance context. Preserve
    // legacy credential precedence unless an explicit native subscription route
    // was saved; that route must be unique and must never fall back to a key.
    const settings = await catalogOptions.harnessSettingsSource?.getSnapshot({ suppressFundedProbes: true });
    const claude = settings?.harnesses.filter(row => row.harness === "claude") ?? [];
    const native = claude.filter(row => row.configuredAccessSourceId === "owner_claude_profile"
      || row.accessSourceId === "owner_claude_profile" || row.selectedAccountId === "owner_claude_profile");
    let selectedSource: "owner_claude_profile" | undefined;
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
      selectedSource = "owner_claude_profile";
    }
    return buildKernelCredentialLaunch(
      homePath, process.env, selectedSource, fundedCredentialProvider,
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
