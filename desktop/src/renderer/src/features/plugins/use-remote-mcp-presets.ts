import { useCallback, useEffect, useState } from "react";
import { buildMcpConnectionInventory, parseRemoteMcpCatalog, type McpInventoryEntry, type RemoteMcpPreset } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";
import { useIntegrations } from "../integrations/integrations-store";

/** Preset catalog plus the shared MCP + legacy connected-app inventory for Electron Desktop. */
export function useRemoteMcpPresets(api: ApiClient | null) {
  const connectedApps = useIntegrations((state) => state.connections);
  const availableApps = useIntegrations((state) => state.available);
  const integrationsStatus = useIntegrations((state) => state.status);
  const refreshIntegrations = useIntegrations((state) => state.refresh);
  const [presets, setPresets] = useState<RemoteMcpPreset[]>([]);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading");

  const loadCatalog = useCallback(() => {
    if (!api) { setCatalogState("error"); return; }
    setCatalogState("loading");
    void api.get<unknown>("/api/mcp-servers/catalog").then(parseRemoteMcpCatalog).then((next) => {
      setPresets(next);
      setCatalogState("ready");
    }, (catalogError: unknown) => {
      console.warn("[custom-mcp] catalog load failed:", catalogError instanceof Error ? catalogError.name : typeof catalogError);
      setCatalogState("error");
    });
  }, [api]);
  // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- mount loads the external preset catalog; the same callback serves Retry.
  useEffect(() => { loadCatalog(); }, [loadCatalog]);
  // Legacy connected apps share the inventory; load them once if Integrations has not.
  useEffect(() => {
    if (api && integrationsStatus === "idle") void refreshIntegrations(api);
  }, [api, integrationsStatus, refreshIntegrations]);

  const inventoryFor = (servers: ReadonlyArray<{ id: string; name: string; url: string; status: string }>): McpInventoryEntry[] =>
    buildMcpConnectionInventory(
      servers,
      connectedApps.map((app) => ({ id: app.id, service: app.service, account_label: app.accountLabel, status: app.status })),
      Object.fromEntries(availableApps.map((app) => [app.id, app.name])),
    );

  return { presets, catalogState, loadCatalog, inventoryFor };
}
