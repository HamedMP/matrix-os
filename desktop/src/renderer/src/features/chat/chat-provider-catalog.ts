import {
  CanonicalProviderCatalogSchema,
  FUNDED_AI_READINESS_TIMEOUTS,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canonicalChatProviderCatalogPath } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";

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
    canonicalChatProviderCatalogPath(refresh),
    { timeoutMs: FUNDED_AI_READINESS_TIMEOUTS.rendererRequestMs },
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
  hasTrustedCatalog: boolean;
} {
  const connectionApi = useConnection((state) => state.api);
  const connectionStatus = useConnection((state) => state.status);
  const identityKey = useConnection(desktopProviderIdentityKey);
  const catalogGeneration = useConnection((state) => state.providerCatalogGeneration);
  const { api: apiOverride, active = true } = options;
  const api = apiOverride === undefined ? connectionApi : apiOverride;
  const unavailableCatalog = useMemo(() => failClosedProviderCatalog(fallback), [fallback]);
  const [state, setState] = useState<{
    catalog: CanonicalProviderCatalog;
    status: "fallback" | "loading" | "ready" | "error";
    identityKey: string;
    generation: number;
    api: typeof api;
  }>(() => ({ catalog: fallback, status: api && active ? "loading" : "fallback", identityKey, generation: catalogGeneration, api }));

  const trustedCatalogRef = useRef<{ api: Pick<ApiClient, "get">; catalog: CanonicalProviderCatalog; identityKey: string; generation: number } | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => () => { trustedCatalogRef.current = null; }, []);

  useEffect(() => {
    let cancelled = false;
    let requestSequence = 0;
    let lastTrustedCatalog = trustedCatalogRef.current?.api === api
      && trustedCatalogRef.current.identityKey === identityKey
      && trustedCatalogRef.current.generation === catalogGeneration
      ? trustedCatalogRef.current.catalog : null;
    if (!active || !api || typeof api.get !== "function") {
      trustedCatalogRef.current = null;
      refreshRef.current = () => undefined;
      setState({ catalog: fallback, status: "fallback", identityKey, generation: catalogGeneration, api });
      return () => {
        cancelled = true;
      };
    }
    if (!lastTrustedCatalog) trustedCatalogRef.current = null;
    const retainedCatalog = lastTrustedCatalog;
    setState((current) => ({
      catalog: retainedCatalog ?? unavailableCatalog,
      identityKey, generation: catalogGeneration, api,
      status: retainedCatalog ? current.status === "error" ? "error" : "ready" : "loading",
    }));
    const isCurrentScope = () => {
      const current = useConnection.getState();
      return desktopProviderIdentityKey(current) === identityKey
        && current.providerCatalogGeneration === catalogGeneration;
    };
    const update = () => {
      const request = ++requestSequence;
      setState({ catalog: lastTrustedCatalog ?? unavailableCatalog,
        identityKey, generation: catalogGeneration, api, status: "loading" });
      void fetchCanonicalProviderCatalog(api, true).then((catalog) => {
        if (!cancelled && request === requestSequence && isCurrentScope()) {
          lastTrustedCatalog = catalog;
          trustedCatalogRef.current = { api, catalog, identityKey, generation: catalogGeneration };
          setState({ catalog, status: "ready", identityKey, generation: catalogGeneration, api });
        }
      }).catch((error: unknown) => {
        console.warn(
          "[chat] Provider catalog unavailable:",
          error instanceof Error ? error.name : "UnknownError",
        );
        if (!cancelled && request === requestSequence && isCurrentScope()) setState({
          catalog: lastTrustedCatalog ?? unavailableCatalog,
          identityKey, generation: catalogGeneration, api,
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
  }, [active, api, fallback, unavailableCatalog, identityKey, catalogGeneration]);

  // A scope/change render must fail closed before passive effects run. Old
  // state must never be observable by a composer or a layout-effect consumer.
  const current = state.identityKey === identityKey && state.generation === catalogGeneration && state.api === api;
  const trusted = trustedCatalogRef.current;
  // Auth bootstrap precedes API creation. Show pending discovery only for
  // that explicit loading state, never for inactive or settled offline routes.
  const bootstrapLoading = active && !api && connectionStatus === "loading";
  const hasTrustedCatalog = Boolean(current && trusted && trusted.api === api && trusted.identityKey === identityKey && trusted.generation === catalogGeneration);
  return { catalog: !bootstrapLoading && current && (state.status !== "loading" || hasTrustedCatalog) ? state.catalog : unavailableCatalog,
    status: bootstrapLoading ? "loading" : current ? state.status : "loading", refresh, hasTrustedCatalog };
}
