import type { AgentProviderSummary, CanonicalChatModelSelection } from "@matrix-os/contracts";
import type { CodingAgentProviderRegistry } from "../coding-agents/provider-registry.js";
import type { RequestPrincipal } from "../request-principal.js";
import type { CodingModelCatalogProjection } from "./provider-catalog.js";

/** Internal-only native alias resolution. Never adds fields to the public catalog. */
export function createNativeExecutionModelResolver(options: {
  codingProviders: Pick<CodingAgentProviderRegistry, "listProviders">;
  codingModelCatalogSource?: (provider: AgentProviderSummary, principal: RequestPrincipal) => Promise<CodingModelCatalogProjection | null>;
}) {
  return async (principal: RequestPrincipal, selection: CanonicalChatModelSelection): Promise<string | null> => {
    if (selection.instanceId !== "claude_code_default" || !options.codingModelCatalogSource) return null;
    const providers = await options.codingProviders.listProviders(principal);
    const provider = providers.find(candidate => (candidate.id === "claude" || candidate.kind === "claude")
      && candidate.availability === "available" && candidate.authStatus === "authenticated");
    if (!provider) return null;
    const inventory = await options.codingModelCatalogSource(provider, principal);
    const models = inventory?.executionModels;
    return models && Object.hasOwn(models, selection.model) ? models[selection.model]! : null;
  };
}
