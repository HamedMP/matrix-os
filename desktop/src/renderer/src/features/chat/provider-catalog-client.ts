import {
  CanonicalProviderCatalogSchema,
  FUNDED_AI_READINESS_TIMEOUTS,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { canonicalChatProviderCatalogPath } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";

export function failClosedProviderCatalog(
  catalog: CanonicalProviderCatalog,
  affectedInstanceIds: readonly string[] | null = null,
): CanonicalProviderCatalog {
  return {
    ...catalog,
    instances: catalog.instances.map((instance) => {
      if (affectedInstanceIds && !affectedInstanceIds.includes(instance.id)) return instance;
      const { defaultSelection: _selection, ...rest } = instance;
      return { ...rest, availability: "unavailable",
        models: instance.models.map((model) => ({ ...model, availability: "unavailable" })) };
    }),
  };
}

export async function fetchCanonicalProviderCatalog(
  api: Pick<ApiClient, "get">,
  refresh = false,
  signal?: AbortSignal,
): Promise<CanonicalProviderCatalog> {
  return CanonicalProviderCatalogSchema.parse(await api.get<unknown>(
    canonicalChatProviderCatalogPath(refresh),
    { timeoutMs: FUNDED_AI_READINESS_TIMEOUTS.rendererRequestMs, ...(signal ? { signal } : {}) },
  ));
}
