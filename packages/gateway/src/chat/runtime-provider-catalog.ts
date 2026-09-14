import { loadSkills } from "@matrix-os/kernel";
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
    ? createCodexModelCatalogSource({ executable: codexExecutable, cwd: homePath })
    : undefined;
  const nativeCodingModelCatalogSource = createNativeCodingModelCatalogSource({ homePath });
  const resolveClaudeCredentialLaunch = () => buildKernelCredentialLaunch(
    homePath, process.env, undefined, fundedCredentialProvider,
  );
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
