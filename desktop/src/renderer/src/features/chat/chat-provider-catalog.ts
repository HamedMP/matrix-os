import {
  CanonicalProviderCatalogSchema,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";

export async function fetchCanonicalProviderCatalog(
  api: Pick<ApiClient, "get">,
): Promise<CanonicalProviderCatalog> {
  return CanonicalProviderCatalogSchema.parse(await api.get<unknown>("/api/chat-providers"));
}

export function useChatProviderCatalog(
  fallback: CanonicalProviderCatalog,
): {
  catalog: CanonicalProviderCatalog;
  status: "fallback" | "loading" | "ready" | "error";
} {
  const api = useConnection((state) => state.api);
  const [state, setState] = useState<{
    catalog: CanonicalProviderCatalog;
    status: "fallback" | "loading" | "ready" | "error";
  }>(() => ({ catalog: fallback, status: api ? "loading" : "fallback" }));

  useEffect(() => {
    let cancelled = false;
    if (!api || typeof api.get !== "function") {
      setState({ catalog: fallback, status: "fallback" });
      return () => {
        cancelled = true;
      };
    }
    setState({ catalog: fallback, status: "loading" });
    void fetchCanonicalProviderCatalog(api).then((catalog) => {
      if (!cancelled) setState({ catalog, status: "ready" });
    }).catch((error: unknown) => {
      console.warn(
        "[chat] Provider catalog unavailable:",
        error instanceof Error ? error.name : "UnknownError",
      );
      if (!cancelled) setState({ catalog: fallback, status: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [api, fallback]);

  return state;
}
