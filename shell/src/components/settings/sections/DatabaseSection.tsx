"use client";
import { useAuth } from "@clerk/nextjs";
import React, { useCallback, useMemo, useSyncExternalStore } from "react";
import { DatabaseSettings, createDatabaseClient, createDatabaseFetchTransport, downloadDatabaseExport, openDatabaseTerminal } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { isSelfHostedRuntime } from "@/lib/self-host-mode";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

const subscribeToRuntimeDocument = () => () => {};

export function DatabaseSection(props: { onOpenTerminal?: (sessionId: string) => void }) {
  const selfHosted = useSyncExternalStore<boolean | null>(subscribeToRuntimeDocument, isSelfHostedRuntime, () => null);
  if (selfHosted === null) return <p role="status">Loading database access…</p>;
  return selfHosted ? <DatabaseAdapter {...props} accountKey="self-hosted" /> : <ManagedDatabaseSection {...props} />;
}
function ManagedDatabaseSection(props: { onOpenTerminal?: (sessionId: string) => void }) {
  const { userId, sessionId } = useAuth();
  return <DatabaseAdapter {...props} accountKey={`${userId ?? "signed-out"}:${sessionId ?? "none"}`} />;
}
function DatabaseAdapter({ onOpenTerminal, accountKey }: { onOpenTerminal?: (sessionId: string) => void; accountKey: string }) {
  const baseUrl = getGatewayUrl(); const identityKey = `${baseUrl}:${accountKey}`;
  const transport = useMemo(() => createDatabaseFetchTransport(baseUrl), [baseUrl, accountKey]);
  const client = useMemo(() => createDatabaseClient(transport), [transport]);
  const launch = useCallback((command: string, signal: AbortSignal) => openDatabaseTerminal(
    transport, command, signal, sessionId => onOpenTerminal?.(sessionId), () => getGatewayUrl() === baseUrl,
  ), [baseUrl, transport, onOpenTerminal]);
  return <DatabaseSettings client={client} identityKey={identityKey} dialogLayer={SHELL_Z_INDEX.settingsDialog} onOpenTerminal={onOpenTerminal ? launch : undefined} onDownload={downloadDatabaseExport} />;
}
