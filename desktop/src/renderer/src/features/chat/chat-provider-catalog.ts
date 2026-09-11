import {
  CanonicalProviderCatalogSchema,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";

export function failClosedProviderCatalog(
  catalog: CanonicalProviderCatalog,
): CanonicalProviderCatalog {
  return {
    ...catalog,
    instances: catalog.instances.map(({ defaultSelection: _selection, ...instance }) => ({
      ...instance,
      availability: "unavailable",
      models: instance.models.map((model) => ({ ...model, availability: "unavailable" })),
    })),
  };
}

export async function fetchCanonicalProviderCatalog(
  api: Pick<ApiClient, "get">,
  refresh = false,
): Promise<CanonicalProviderCatalog> {
  return CanonicalProviderCatalogSchema.parse(await api.get<unknown>(
    refresh ? "/api/chat-providers?refresh=true" : "/api/chat-providers",
  ));
}

export function useChatProviderCatalog(
  fallback: CanonicalProviderCatalog,
  options: {
    api?: Pick<ApiClient, "get"> | null;
    active?: boolean;
  } = {},
): {
  catalog: CanonicalProviderCatalog;
  status: "fallback" | "loading" | "ready" | "error";
} {
  const connectionApi = useConnection((state) => state.api);
  const { api: apiOverride, active = true } = options;
  const api = apiOverride === undefined ? connectionApi : apiOverride;
  const [state, setState] = useState<{
    catalog: CanonicalProviderCatalog;
    status: "fallback" | "loading" | "ready" | "error";
  }>(() => ({ catalog: fallback, status: api && active ? "loading" : "fallback" }));

  useEffect(() => {
    let cancelled = false;
    if (!active || !api || typeof api.get !== "function") {
      setState({ catalog: fallback, status: "fallback" });
      return () => {
        cancelled = true;
      };
    }
    setState({ catalog: fallback, status: "loading" });
    const update = (refresh = false) => void fetchCanonicalProviderCatalog(api, refresh).then((catalog) => {
      if (!cancelled) setState({ catalog, status: "ready" });
    }).catch((error: unknown) => {
      console.warn(
        "[chat] Provider catalog unavailable:",
        error instanceof Error ? error.name : "UnknownError",
      );
      if (!cancelled) setState({ catalog: fallback, status: "error" });
    });
    update(true);
    const refresh = () => update(true);
    window.addEventListener("focus", refresh);
    const visibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [active, api, fallback]);

  return state;
}
