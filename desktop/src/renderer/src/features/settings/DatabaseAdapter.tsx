import React, { useMemo } from "react";
import { DatabaseSettings, createDatabaseClient, DATABASE_ACTION_HEADERS, DATABASE_EXPORT_MAX_BYTES, DATABASE_ERROR, downloadDatabaseExport, openDatabaseTerminal, type DatabaseTransport } from "@matrix-os/ui";
import { useConnection } from "../../stores/connection";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { useShellSessions } from "../../stores/shell-sessions";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useTabs } from "../../stores/tabs";

export default function DatabaseAdapter() {
  const api = useConnection(state => state.api);
  const identityKey = useConnection(desktopProviderIdentityKey);
  const runtimeSlot = useConnection(state => state.runtimeSlot);
  const runtimeApi = useMemo(() => api?.forRuntime(runtimeSlot), [api, runtimeSlot]);
  const transport = useMemo<DatabaseTransport>(() => ({
    async json(path, body, signal) {
      if (!runtimeApi || signal.aborted || desktopProviderIdentityKey(useConnection.getState()) !== identityKey) throw new Error(DATABASE_ERROR);
      const options = {signal,maxBytes:16*1024,timeoutMs:15_000,headers:DATABASE_ACTION_HEADERS};
      return body === undefined ? runtimeApi.get(path, options) : runtimeApi.post(path,body,options);
    },
    async export(signal) {
      if (!runtimeApi || signal.aborted || desktopProviderIdentityKey(useConnection.getState()) !== identityKey) throw new Error(DATABASE_ERROR);
      return runtimeApi.postBlob("/api/database/export",{confirm:"export"},{signal,headers:DATABASE_ACTION_HEADERS,maxBytes:DATABASE_EXPORT_MAX_BYTES,timeoutMs:300_000});
    },
  }), [runtimeApi, identityKey]);
  const client = useMemo(() => createDatabaseClient(transport), [transport]);
  return <DatabaseSettings identityKey={identityKey} client={client} onDownload={downloadDatabaseExport} onOpenTerminal={async (command, signal) => {
    if (!runtimeApi || signal.aborted || desktopProviderIdentityKey(useConnection.getState()) !== identityKey) throw new Error(DATABASE_ERROR);
    await openDatabaseTerminal(transport, command, signal, sessionId => {
      useShellSessions.getState().adoptCreatedSession(sessionId);
      const tabId = useTabs.getState().openTab({kind:"terminals",title:"Terminal"});
      useDesktopSurfaces.getState().activateSurface(tabId);
      useTabs.getState().requestTerminalSession(sessionId);
    }, () => desktopProviderIdentityKey(useConnection.getState()) === identityKey);
  }} />;
}
