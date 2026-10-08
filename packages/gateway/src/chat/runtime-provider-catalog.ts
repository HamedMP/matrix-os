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

// Voice readiness and Aoede bootstrap read the catalog several times per
// open (bootstrap, capabilities, session admission) and only need route
// availability, never a fresh model list. Sharing clean reads for this long
// keeps one slow probe fan-out from becoming a readiness timeout.
const READINESS_CATALOG_REUSE_MS = 15_000;

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
  const resolveClaudeCredentialLaunch = async (context?: { runId: string }) => {
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
  const serviceOptions: Parameters<typeof createChatProviderCatalogService>[0] = {
    ...catalogOptions,
    skillsSource: () => loadSkills(homePath),
    invalidateCodingModelCatalog: claudeModelCatalogSource.invalidate,
    codingModelCatalogSource: async (provider, principal) => {
      const claudeModels = await claudeModelCatalogSource(provider, principal);
      if (claudeModels) return claudeModels;
      const codexModels = await codexModelCatalogSource?.(provider);
      return codexModels ?? nativeCodingModelCatalogSource(provider);
    },
  };
  const catalog = createChatProviderCatalogService(serviceOptions);
  const completeReadinessCatalog = createChatProviderCatalogService({
    ...serviceOptions, cacheTtlMs: READINESS_CATALOG_REUSE_MS,
  });
  // Aoede's canonical route is Codex. Probe it alone first so a cold Pi,
  // OpenCode, Claude, Hermes, or OpenClaw process cannot delay a usable route.
  // If Codex is not truthfully runnable, retain the complete catalog fallback.
  const codexReadinessCatalog = createChatProviderCatalogService({
    ...serviceOptions,
    cacheTtlMs: READINESS_CATALOG_REUSE_MS,
    preferredCodingProviderId: "codex",
  });
  const hasRunnableCodex = (candidate: Awaited<ReturnType<typeof codexReadinessCatalog.getCatalog>>) =>
    candidate.instances.some((instance) => instance.driverKind === "codex"
      && instance.defaultSelection
      && instance.availability === "available");
  const readinessCatalog = {
    async getCatalog(principal: Parameters<typeof codexReadinessCatalog.getCatalog>[0], requestedInstanceId?: string) {
      if (requestedInstanceId !== undefined && requestedInstanceId !== "codex_default") {
        return completeReadinessCatalog.getCatalog(principal);
      }
      try {
        const candidate = await codexReadinessCatalog.getCatalog(principal);
        if (hasRunnableCodex(candidate)) return candidate;
      } catch (_error) {
        console.warn("[chat-providers] Preferred Codex readiness unavailable");
      }
      return completeReadinessCatalog.getCatalog(principal);
    },
    async refresh(principal: Parameters<typeof codexReadinessCatalog.refresh>[0]) {
      // Explicit refresh invalidates both views so a later fallback can never
      // resurrect pre-refresh readiness. Refresh is user-driven, not the cold path.
      const [preferred, complete] = await Promise.allSettled([
        codexReadinessCatalog.refresh(principal),
        completeReadinessCatalog.refresh(principal),
      ]);
      if (preferred.status === "fulfilled" && hasRunnableCodex(preferred.value)) return preferred.value;
      if (complete.status === "fulfilled") return complete.value;
      throw complete.reason;
    },
  };
  // Execution and metadata discovery must resolve the same owner credentials.
  return { catalog, readinessCatalog, resolveClaudeCredentialLaunch };
}
