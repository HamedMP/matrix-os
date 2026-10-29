import { createAgentProviderCatalogSource, type AgentProviderCatalogSource } from "@matrix-os/ui";
import { useMemo } from "react";
import { createLegacyGlobalProviderCatalog } from "../chat/canonical-composer-adapter";
import { useChatProviderCatalog } from "../chat/chat-provider-catalog";

export function useWorkAgentProviderCatalog(
  hasProject: boolean,
  active: boolean,
): AgentProviderCatalogSource {
  const fallbackCatalog = useMemo(
    () => createLegacyGlobalProviderCatalog({ hasProject }),
    [hasProject],
  );
  const catalogState = useChatProviderCatalog(fallbackCatalog, { active });

  return useMemo(() => createAgentProviderCatalogSource({
    catalog: catalogState.catalog,
    hasTrustedCatalog: catalogState.hasTrustedCatalog,
    loading: catalogState.initialLoading,
    refreshError: Boolean(catalogState.refreshError),
    refresh: catalogState.refresh,
  }), [
    catalogState.catalog,
    catalogState.hasTrustedCatalog,
    catalogState.initialLoading,
    catalogState.refreshError,
    catalogState.refresh,
  ]);
}
