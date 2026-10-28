import type { AgentProviderCatalogSource } from "@matrix-os/ui";
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

  return useMemo(() => ({
    catalog: catalogState.hasTrustedCatalog ? catalogState.catalog : null,
    loading: catalogState.initialLoading,
    error: catalogState.refreshError ? "Models could not be refreshed. Your draft is still here." : "",
    refresh: catalogState.refresh,
  }), [
    catalogState.catalog,
    catalogState.hasTrustedCatalog,
    catalogState.initialLoading,
    catalogState.refreshError,
    catalogState.refresh,
  ]);
}
