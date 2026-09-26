import {
  CanonicalProviderCatalogSchema,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
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
    refresh ? "/api/chat-providers?refresh=true&includeConnectionLabels=true" : "/api/chat-providers?includeConnectionLabels=true",
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
  refresh: () => void;
} {
  const connectionApi = useConnection((state) => state.api);
  const { api: apiOverride, active = true } = options;
  const api = apiOverride === undefined ? connectionApi : apiOverride;
  const [state, setState] = useState<{
    catalog: CanonicalProviderCatalog;
    status: "fallback" | "loading" | "ready" | "error";
  }>(() => ({ catalog: fallback, status: api && active ? "loading" : "fallback" }));

  const trustedCatalogRef = useRef<{ api: Pick<ApiClient, "get">; catalog: CanonicalProviderCatalog } | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => () => { trustedCatalogRef.current = null; }, []);

  useEffect(() => {
    let cancelled = false;
    let requestSequence = 0;
    let lastTrustedCatalog = trustedCatalogRef.current?.api === api
      ? trustedCatalogRef.current.catalog : null;
    if (!active || !api || typeof api.get !== "function") {
      trustedCatalogRef.current = null;
      refreshRef.current = () => undefined;
      setState({ catalog: fallback, status: "fallback" });
      return () => {
        cancelled = true;
      };
    }
    if (!lastTrustedCatalog) trustedCatalogRef.current = null;
    const retainedCatalog = lastTrustedCatalog;
    setState((current) => ({
      catalog: retainedCatalog ?? fallback,
      status: retainedCatalog ? current.status === "error" ? "error" : "ready" : "loading",
    }));
    const update = () => {
      const request = ++requestSequence;
      void fetchCanonicalProviderCatalog(api, true).then((catalog) => {
        if (!cancelled && request === requestSequence) {
          lastTrustedCatalog = catalog;
          trustedCatalogRef.current = { api, catalog };
          setState({ catalog, status: "ready" });
        }
      }).catch((error: unknown) => {
        console.warn(
          "[chat] Provider catalog unavailable:",
          error instanceof Error ? error.name : "UnknownError",
        );
        if (!cancelled && request === requestSequence) setState({
          catalog: lastTrustedCatalog ?? failClosedProviderCatalog(fallback),
          status: "error",
        });
      });
    };
    refreshRef.current = update;
    update();
    const refresh = update;
    window.addEventListener("focus", refresh);
    const visibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelled = true;
      refreshRef.current = () => undefined;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [active, api, fallback]);

  return { ...state, refresh };
}
