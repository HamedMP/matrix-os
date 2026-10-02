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
  const resolveClaudeCredentialLaunch = () => buildKernelCredentialLaunch(
    homePath, process.env, undefined, fundedCredentialProvider,
  );
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
    async getCatalog(principal: Parameters<typeof codexReadinessCatalog.getCatalog>[0]) {
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
