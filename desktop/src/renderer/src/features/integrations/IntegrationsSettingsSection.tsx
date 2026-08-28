// Self-contained desktop settings section for third-party integrations.
// Data flows through the gateway proxy routes /api/integrations* (see
// features/integrations/integrations-store.ts). Connect opens the OAuth
// consent URL through the HTTPS-only shell:open-external bridge, then polls
// the sync endpoint with backoff until the account lands; Disconnect asks
// for confirmation first. The renderer only displays name/category/label/
// email/status — never tokens, remote logos, or upstream error text.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { diagnosticErrorKind } from "../../lib/errors";
import { invoke } from "../../lib/operator";
import { categoryMessage } from "../../../../shared/app-error";
import { RefreshButton } from "../settings/sections/ProvidersSection";
import { useConnection } from "../../stores/connection";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { AvailableServiceCard } from "./AvailableServiceCard";
import { ConnectPendingBanner } from "./ConnectPendingBanner";
import { DEFAULT_CONNECT_POLL_INTERVALS_MS, startConnectPoll } from "./connect-poll";
import { DisconnectConfirmDialog } from "./DisconnectConfirmDialog";
import { EmptyCatalogState, ErrorState, LoadingSkeleton, UnavailableState } from "./IntegrationStatusViews";
import { useIntegrations } from "./integrations-store";
import { displayIntegrationName } from "./types";
import { SettingsSectionHeader } from "../settings/sections/section-kit";

const GENERIC_ERROR = categoryMessage("server");

export interface IntegrationsSettingsSectionProps {
  // Test-only hook: override the connect poll backoff schedule.
  pollIntervals?: number[];
}

export function IntegrationsSettingsSection({ pollIntervals }: IntegrationsSettingsSectionProps = {}) {
  const api = useConnection((s) => s.api);
  const available = useIntegrations((s) => s.available);
  const connections = useIntegrations((s) => s.connections);
  const status = useIntegrations((s) => s.status);
  const errorMessage = useIntegrations((s) => s.errorMessage);

  const [connectingService, setConnectingService] = useState<string | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualNote, setManualNote] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const cancelPollRef = useRef<(() => void) | null>(null);
  const previousIdsRef = useRef<Set<string> | null>(null);
  const connectAttemptRef = useRef(0);
  const disconnectAttemptRef = useRef(0);

  useEffect(() => {
    // OAuth work is identity-bound. Invalidate both scheduled and in-flight
    // callbacks before loading the next account/computer's integration state.
    connectAttemptRef.current += 1;
    disconnectAttemptRef.current += 1;
    cancelPollRef.current?.();
    cancelPollRef.current = null;
    previousIdsRef.current = null;
    setConnectingService(null);
    setManualBusy(false);
    setManualNote(null);
    setConfirmId(null);
    setDisconnectingId(null);
    void useIntegrations.getState().refresh(api);
  }, [api]);

  // Unmount teardown: a live poll must not settle into a gone component.
  useEffect(() => {
    return () => {
      cancelPollRef.current?.();
      cancelPollRef.current = null;
    };
  }, []);

  const cancelConnectPoll = (): void => {
    cancelPollRef.current?.();
    cancelPollRef.current = null;
  };

  const refresh = (): void => {
    void useIntegrations.getState().refresh(api);
  };

  const handleConnect = async (serviceId: string): Promise<void> => {
    if (!api || connectingService) return;
    const attempt = ++connectAttemptRef.current;
    const runtimeGeneration = captureRuntimeGeneration();
    const isCurrentAttempt = (): boolean =>
      connectAttemptRef.current === attempt && isCurrentRuntimeGeneration(runtimeGeneration);
    setManualNote(null);
    setConnectingService(serviceId);
    const previousIds = new Set(useIntegrations.getState().connections.map((conn) => conn.id));
    previousIdsRef.current = previousIds;

    const url = await useIntegrations.getState().startConnect(serviceId, api);
    if (!isCurrentAttempt()) return;
    if (!url) {
      setConnectingService(null);
      return;
    }
    try {
      await invoke("shell:open-external", { url });
    } catch (err: unknown) {
      if (!isCurrentAttempt()) return;
      console.warn("[integrations] failed to open consent url:", diagnosticErrorKind(err));
      useIntegrations.getState().showError(GENERIC_ERROR);
      setConnectingService(null);
      return;
    }
    if (!isCurrentAttempt()) return;

    const isLanded = () =>
      useIntegrations
        .getState()
        .connections.some((conn) => conn.service === serviceId && !previousIds.has(conn.id));

    cancelConnectPoll();
    cancelPollRef.current = startConnectPoll({
      intervals: pollIntervals ?? DEFAULT_CONNECT_POLL_INTERVALS_MS,
      tick: async () => {
        if (!isCurrentAttempt()) {
          cancelConnectPoll();
          return;
        }
        const result = await useIntegrations.getState().syncNow(api);
        // A superseded tick means the user changed account/computer; stop
        // polling rather than keep asking on behalf of the previous one.
        if (result === "superseded") cancelConnectPoll();
      },
      isDone: isLanded,
      onSettled: (found) => {
        if (!isCurrentAttempt()) return;
        cancelPollRef.current = null;
        if (found) {
          setConnectingService(null);
          return;
        }
        setManualNote("Still waiting — finish the sign-in in your browser, then select I've connected.");
      },
    });
  };

  const handleManualConfirm = async (): Promise<void> => {
    if (!api || !connectingService || manualBusy) return;
    const attempt = connectAttemptRef.current;
    const runtimeGeneration = captureRuntimeGeneration();
    const isCurrentAttempt = (): boolean =>
      connectAttemptRef.current === attempt && isCurrentRuntimeGeneration(runtimeGeneration);
    setManualBusy(true);
    setManualNote(null);
    try {
      const result = await useIntegrations.getState().syncNow(api);
      if (!isCurrentAttempt()) return;
      const landed = useIntegrations
        .getState()
        .connections.some((conn) => conn.service === connectingService && !previousIdsRef.current?.has(conn.id));
      if (landed) {
        cancelConnectPoll();
        setConnectingService(null);
        return;
      }
      // "superseded" is not a failure: the account/computer changed underneath
      // this click, so showing a red banner would be a lie.
      if (result === "failed") {
        useIntegrations.getState().showError(GENERIC_ERROR);
        return;
      }
      if (result === "superseded") return;
      setManualNote("Not connected yet — finish the sign-in in your browser, then try again.");
    } finally {
      if (isCurrentAttempt()) setManualBusy(false);
    }
  };

  const handleCancelConnect = (): void => {
    connectAttemptRef.current += 1;
    cancelConnectPoll();
    setConnectingService(null);
    setManualNote(null);
  };

  const handleDisconnect = async (): Promise<void> => {
    if (!api || !confirmId) return;
    const connectionId = confirmId;
    const attempt = ++disconnectAttemptRef.current;
    const runtimeGeneration = captureRuntimeGeneration();
    setDisconnectingId(connectionId);
    await useIntegrations.getState().disconnect(connectionId, api);
    if (disconnectAttemptRef.current !== attempt
      || !isCurrentRuntimeGeneration(runtimeGeneration)) return;
    setDisconnectingId(null);
    // Close either way: on failure the row stays and the store's generic
    // errorMessage banner explains it (partial-failure safe).
    setConfirmId(null);
  };

  const confirmConnection = connections.find((conn) => conn.id === confirmId) ?? null;
  const connectingName = connectingService
    ? (available.find((service) => service.id === connectingService)?.name ?? connectingService)
    : null;

  const catalogServices = useMemo(() => {
    const known = new Set(available.map((service) => service.id));
    return [
      ...available,
      ...connections
        .filter((connection) => !known.has(connection.service))
        .map((connection) => ({
          id: connection.service,
          name: displayIntegrationName(connection.service),
          category: "other",
        })),
    ];
  }, [available, connections]);

  let body: ReactNode;
  if (status === "idle" || status === "loading") {
    body = <LoadingSkeleton />;
  } else if (status === "unavailable") {
    body = <UnavailableState />;
  } else if (status === "error") {
    body = <ErrorState message={errorMessage ?? GENERIC_ERROR} onRetry={refresh} />;
  } else {
    body = (
      <>
        {errorMessage ? (
          <p
            data-testid="integrations-error"
            className="mb-4 rounded-lg border px-3 py-2 text-sm"
            style={{ color: "var(--danger)", borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
          >
            {errorMessage}
          </p>
        ) : null}

        <section>
          {available.length === 0 && connections.length === 0 ? (
            <EmptyCatalogState />
          ) : (
            <div data-testid="integrations-grid" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {catalogServices.map((service) => {
                const connection = connections.find((conn) => conn.service === service.id);
                const serviceConnections = connections.filter((conn) => conn.service === service.id);
                return (
                  <AvailableServiceCard
                    key={service.id}
                    service={service}
                    connected={connection !== undefined}
                    connection={connection}
                    connections={serviceConnections}
                    connecting={connectingService === service.id}
                    disabled={connectingService !== null}
                    onConnect={() => void handleConnect(service.id)}
                    onDisconnect={connection ? () => setConfirmId(connection.id) : undefined}
                  />
                );
              })}
            </div>
          )}
        </section>

        {connectingService ? (
          <ConnectPendingBanner
            serviceName={connectingName ?? connectingService}
            manualBusy={manualBusy}
            manualNote={manualNote}
            onConfirm={() => void handleManualConfirm()}
            onCancel={handleCancelConnect}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <SettingsSectionHeader
          className="mb-0"
          title="Integrations"
          description="Connect extra services to extend your agent's capabilities."
        />
        {status === "ready" ? <RefreshButton onClick={refresh} /> : null}
      </div>

      {body}

      <DisconnectConfirmDialog
        connection={confirmConnection}
        disconnecting={disconnectingId !== null}
        onCancel={() => setConfirmId(null)}
        onConfirm={() => void handleDisconnect()}
      />
    </>
  );
}

export default IntegrationsSettingsSection;
