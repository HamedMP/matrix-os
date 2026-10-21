"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getGatewayUrl, getGatewayWs } from "@/lib/gateway";
import { buildAuthenticatedWebSocketUrl } from "@/lib/websocket-auth";
import {
  hasNewConnectionForService,
  shouldLogIntegrationWarning,
  type ConnectedService,
} from "./integrations-helpers";
import { GmailConnectionChoice, useGmailConnectionChoice, IntegrationMarketplace } from "@matrix-os/ui";
import type { GmailConnectionMethod, IntegrationCatalogItem } from "@matrix-os/contracts/integration-marketplace";
import { ConnectedIntegrationAccounts } from "./ConnectedIntegrationAccounts";
import { fetchGmailConnectionOptions } from "./gmail-connection-request";
import { CustomMcpServersPanel } from "./CustomMcpServersPanel";

const GATEWAY = getGatewayUrl();

// react-doctor-disable-next-line react-doctor/prefer-useReducer -- the available/connected lists, load/error flags, and the many independent per-action progress flags (connecting, disconnecting, checkingStatus, renaming, etc.) are distinct UI concerns, not a single cohesive state machine; a reducer would not simplify them.
export function IntegrationsSection() {
  const [available, setAvailable] = useState<IntegrationCatalogItem[]>([]);
  const [connected, setConnected] = useState<ConnectedService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [checkingStatus, setCheckingStatus] = useState<string | null>(null);
  // UI2 fix: rename existing connected accounts. renamingId = the row in
  // edit mode (or null), renameDraft = the in-progress text, savingRename =
  // the row currently mid-PATCH (disables Save while in flight).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>("");
  const [savingRename, setSavingRename] = useState<string | null>(null);
  const loadGmailOptions = useCallback(() => fetchGmailConnectionOptions(GATEWAY), []);
  const gmailChoice = useGmailConnectionChoice(loadGmailOptions);
  const connectInFlight = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity is consumed by two useEffect dependency arrays (the mount-load effect and the WebSocket-listener effect); removing useCallback would re-run both effects on every render and reopen the websocket in a loop.
  const loadData = useCallback(async () => {
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the try/finally needed to clear `loading` on every path; the code is correct and the finalizer must run whether the loads resolve, reject, or throw.
    try {
      const readJson = async (url: string) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error("Integrations unavailable");
        return response.json();
      };
      const [availResult, connResult] = await Promise.allSettled([
        readJson(`${GATEWAY}/api/integrations/available`),
        readJson(`${GATEWAY}/api/integrations`),
      ]);
      setError(availResult.status === "rejected" || connResult.status === "rejected" ? "Failed to load integrations" : null);
      for (const result of [availResult, connResult]) {
        if (result.status === "rejected") console.warn("[integrations] Load failed", { errorName: result.reason instanceof Error ? result.reason.name : "UnknownError" });
      }
      if (availResult.status === "fulfilled") {
        const data = availResult.value;
        setAvailable(data.services ?? data);
      }
      if (connResult.status === "fulfilled") {
        const data = connResult.value;
        const connections: ConnectedService[] = data.connections ?? data;
        setConnected(connections);

        // Trigger background sync to pull any Pipedream-side accounts that
        // completed OAuth but whose webhook never reached the gateway (local
        // dev, behind NAT). Previously this only fired when an existing row
        // had a missing email, so a freshly-empty list (just-connected user)
        // never triggered a sync and the UI showed "no integrations" despite
        // Pipedream holding an account. Fire on: (a) empty list, OR (b) any
        // row missing an email.
        const hasMissingEmail = connections.some((c) => !c.account_email);
        const shouldSync = connections.length === 0 || hasMissingEmail;
        if (shouldSync) {
          fetch(`${GATEWAY}/api/integrations/sync`, {
            method: "POST",
            signal: AbortSignal.timeout(30_000),
          })
            .then((r) => r.ok ? r.json() : null)
            .then((data) => {
              if (data?.services) setConnected(data.services);
            })
            .catch((err) => {
              console.warn(
                "[integrations] Background sync failed:",
                err instanceof Error ? err.message : err,
              );
            });
        }
      }
    } catch (err) {
      setError("Failed to load integrations");
      console.error("Failed to load integrations:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Explicit refresh button handler. Unlike loadData, this always issues a
  // sync -- user intent is "pull whatever Pipedream has, I just authorized
  // something." Reuses the same /sync endpoint.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the try/finally needed to clear `refreshing` on every path; the code is correct and the finalizer must run whether the sync resolves, rejects, or throws.
    try {
      const res = await fetch(`${GATEWAY}/api/integrations/sync`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.services) setConnected(data.services);
      } else {
        setError("Could not refresh connected apps. Try again.");
      }
    } catch (err) {
      if (shouldLogIntegrationWarning(err)) {
        console.warn(
          "[integrations] handleRefresh failed:",
          err instanceof Error ? err.message : err,
        );
      }
      setError("Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- mount load of available + connected integrations from the gateway (external async read); state lands in the awaited fetch results inside loadData, which is the documented allowed pattern.
    loadData();
  }, [loadData]);

  // WebSocket listener for real-time connection updates
  useEffect(() => {
    let ws: WebSocket | null = null;
    let disposed = false;
    void buildAuthenticatedWebSocketUrl("/ws")
      .catch((err: unknown) => {
        console.warn(
          "[integrations] Falling back to unauthenticated websocket URL:",
          err instanceof Error ? err.message : err,
        );
        return getGatewayWs();
      })
      .then((wsUrl) => {
        if (disposed) {
          return;
        }
        try {
          ws = new WebSocket(wsUrl);
          ws.onmessage = (event) => {
            try {
              const msg = JSON.parse(event.data);
              if (msg.type === "integration:connected" || msg.type === "integration:disconnected") {
                loadData();
              }
            } catch (_err: unknown) {
              // not JSON, ignore
            }
          };
          ws.onerror = () => {
            // WebSocket errors are non-fatal; polling fallback handles it
          };
        } catch (_err: unknown) {
          // WebSocket not available, rely on polling during connect
        }
      });
    return () => {
      disposed = true;
      ws?.close();
    };
  }, [loadData]);

  const handleConnect = async (serviceId: string, label?: string, connectionMethod?: GmailConnectionMethod) => {
    if (connecting || connectInFlight.current) return;
    connectInFlight.current = true;
    let popup: Window | null = null;
    setConnecting(serviceId);
    setError(null);
    try {
      popup = window.open("about:blank", "_blank", "width=600,height=700");
      if (!popup) throw new Error("Consent window blocked");
      const payload: Record<string, string> = { service: serviceId };
      if (label?.trim()) payload.label = label.trim();
      if (serviceId === "gmail" && connectionMethod) payload.connectionMethod = connectionMethod;
      const res = await fetch(`${GATEWAY}/api/integrations/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setError("Could not start connection. Try again.");
        setConnecting(null);
        popup?.close();
        connectInFlight.current = false;
        return;
      }
      const { url } = await res.json();
      const consentUrl = new URL(url);
      if (consentUrl.protocol !== "https:") throw new Error("Invalid consent URL");
      if (!popup) throw new Error("Consent window blocked");
      popup.opener = null;
      popup.location.href = consentUrl.href;

      // Clear any existing poll before starting a new one
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
      // Poll by syncing from Pipedream every 2s
      const previousIds = new Set(connected.map((c) => c.id));
      pollRef.current = setInterval(async () => {
        try {
          const syncRes = await fetch(`${GATEWAY}/api/integrations/sync`, {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
          });
          if (syncRes.ok) {
            const data = await syncRes.json();
            const list: ConnectedService[] = data.services ?? [];
            const hasNew = hasNewConnectionForService(previousIds, serviceId, list);
            if (hasNew) {
              setConnected(list);
              setConnecting(null);
              if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
              }
              if (pollTimeoutRef.current) {
                clearTimeout(pollTimeoutRef.current);
                pollTimeoutRef.current = null;
              }
            }
          }
        } catch (err) {
          if (shouldLogIntegrationWarning(err)) {
            console.warn(
              "[integrations] poll sync error:",
              err instanceof Error ? err.message : err,
            );
          }
        }
      }, 2000);

      // Stop polling after 2 minutes
      pollTimeoutRef.current = setTimeout(() => {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setConnecting(null);
        }
        pollTimeoutRef.current = null;
      }, 120_000);
    } catch (err) {
      if (shouldLogIntegrationWarning(err)) {
        console.warn(
          "[integrations] handleConnect failed:",
          err instanceof Error ? err.message : err,
        );
      }
      popup?.close();
      setError("Could not open sign-in. Allow popups and try again.");
      setConnecting(null);
    } finally {
      connectInFlight.current = false;
    }
  };

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- unmount-only teardown must clear whichever poll interval/timeout is live at cleanup time; pollRef/pollTimeoutRef are reassigned by handleConnect, so snapshotting them at mount would always capture the initial null and never clear an active poll.
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
  }, []);

  const handleDisconnect = async (id: string) => {
    setDisconnecting(id);
    setConfirmDisconnect(null);
    setError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the try/finally needed to clear `disconnecting` on every path; the code is correct and the finalizer must run whether the delete resolves, rejects, or throws.
    try {
      const res = await fetch(`${GATEWAY}/api/integrations/${id}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        setConnected((prev) => prev.filter((c) => c.id !== id));
      } else {
        setError("Failed to disconnect service");
      }
    } catch (err) {
      if (shouldLogIntegrationWarning(err)) {
        console.warn(
          "[integrations] handleDisconnect failed:",
          err instanceof Error ? err.message : err,
        );
      }
      setError("Failed to disconnect service");
    } finally {
      setDisconnecting(null);
    }
  };

  // UI2 fix: rename a connected account. Optimistically updates the local
  // list on success so the UI reflects the new label without waiting for a
  // refetch. On failure, reverts and surfaces the error.
  const handleRename = async (id: string) => {
    const trimmed = renameDraft.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    setSavingRename(id);
    setError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the try/finally needed to clear `savingRename` on every path; the code is correct and the finalizer must run whether the rename resolves, rejects, or throws.
    try {
      const res = await fetch(`${GATEWAY}/api/integrations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: trimmed }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        setConnected((prev) =>
          prev.map((c) => (c.id === id ? { ...c, account_label: trimmed } : c)),
        );
        setRenamingId(null);
        setRenameDraft("");
      } else {
        setError("Could not rename account. Try again.");
      }
    } catch (err) {
      if (shouldLogIntegrationWarning(err)) {
        console.warn(
          "[integrations] handleRename failed:",
          err instanceof Error ? err.message : err,
        );
      }
      setError("Failed to rename account");
    } finally {
      setSavingRename(null);
    }
  };

  const handleCheckStatus = async (id: string) => {
    setCheckingStatus(id);
    setError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the try/finally needed to clear `checkingStatus` on every path; the code is correct and the finalizer must run whether the status check resolves, rejects, or throws.
    try {
      const res = await fetch(`${GATEWAY}/api/integrations/${id}/status`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = await res.json();
        setConnected((prev) =>
          prev.map((c) => (c.id === id ? { ...c, status: data.status } : c)),
        );
      } else {
        setError("Failed to check connection status");
      }
    } catch (err) {
      if (shouldLogIntegrationWarning(err)) {
        console.warn(
          "[integrations] handleCheckStatus failed:",
          err instanceof Error ? err.message : err,
        );
      }
      setError("Failed to check connection status");
    } finally {
      setCheckingStatus(null);
    }
  };


  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <h2 className="text-lg font-semibold mb-2">Connect Apps</h2>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Connect Apps</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Connect apps to let Matrix work across your tools.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          title="Pull latest state from Pipedream. Useful if you just finished OAuth in another tab and don't see the connection yet."
          className="shrink-0 rounded-md border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors disabled:opacity-50"
        >
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <ConnectedIntegrationAccounts {...{ connected, available, renamingId, renameDraft, savingRename, checkingStatus, confirmDisconnect, disconnecting, setRenameDraft, setRenamingId, setConfirmDisconnect, handleRename, handleCheckStatus, handleDisconnect }} />

      <IntegrationMarketplace services={available} connectedIds={connected.map(c => c.service)} connectingId={connecting} onConnect={id => { if (id === "gmail") gmailChoice.request(method => void handleConnect(id, undefined, method)); else void handleConnect(id); }} />
      <GmailConnectionChoice choice={gmailChoice} />
      <CustomMcpServersPanel />
    </div>
  );
}
