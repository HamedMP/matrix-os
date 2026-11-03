import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { AgentProviderCatalogSource } from "./use-agent-provider-catalog.js";

export const AGENT_PROVIDER_CATALOG_REFRESH_ERROR = "Models could not be refreshed. Your draft is still here.";

/** Adapts a host-owned cache without letting an untrusted fallback authorize creation. */
export function createAgentProviderCatalogSource({
  catalog,
  hasTrustedCatalog,
  loading,
  refreshError,
  refresh,
}: Readonly<{
  catalog: CanonicalProviderCatalog | null;
  hasTrustedCatalog: boolean;
  loading: boolean;
  refreshError: boolean;
  refresh(): void;
}>): AgentProviderCatalogSource {
  const waitingForTrustedCatalog = !hasTrustedCatalog && !refreshError;
  return {
    catalog: hasTrustedCatalog ? catalog : null,
    loading: loading || waitingForTrustedCatalog,
    error: refreshError ? AGENT_PROVIDER_CATALOG_REFRESH_ERROR : "",
    refresh,
  };
}
