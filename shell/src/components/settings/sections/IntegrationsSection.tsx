"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getGatewayUrl, getGatewayWs } from "@/lib/gateway";

const GATEWAY = getGatewayUrl();

interface ServiceDef {
  id: string;
  name: string;
  category: string;
  icon: string;
  logoUrl?: string;
  actions: Record<string, unknown>;
}

interface ConnectedService {
  id: string;
  service: string;
  account_label: string;
  account_email: string | null;
  status: string;
  connected_at: string;
  pipedream_account_id: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  google: "bg-blue-500",
  developer: "bg-gray-700",
  communication: "bg-indigo-500",
};

function ServiceLogo({ name, category, logoUrl }: { name: string; category: string; logoUrl?: string }) {
  const [imgError, setImgError] = useState(false);
  const bg = CATEGORY_COLORS[category] ?? "bg-primary";

  if (logoUrl && !imgError) {
    return (
      <img
        src={logoUrl}
        alt={name}
        width={40}
        height={40}
        className="size-10 rounded-lg shrink-0 object-contain"
        onError={() => setImgError(true)}
      />
    );
  }

  return (
    <div className={`size-10 rounded-lg ${bg} flex items-center justify-center text-white font-semibold text-sm shrink-0`}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "active"
      ? "bg-green-500"
      : status === "expired"
        ? "bg-yellow-500"
        : "bg-red-500";
  return <span className={`inline-block size-2 rounded-full ${color}`} />;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function groupByService(connections: ConnectedService[]): Map<string, ConnectedService[]> {
  const groups = new Map<string, ConnectedService[]>();
  for (const conn of connections) {
    const existing = groups.get(conn.service);
    if (existing) {
      existing.push(conn);
    } else {
      groups.set(conn.service, [conn]);
    }
  }
  return groups;
}

export function IntegrationsSection() {
  const [available, setAvailable] = useState<ServiceDef[]>([]);
  const [connected, setConnected] = useState<ConnectedService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectLabels, setConnectLabels] = useState<Record<string, string>>({});
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [checkingStatus, setCheckingStatus] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [availRes, connRes] = await Promise.all([
        fetch(`${GATEWAY}/api/integrations/available`, { signal: AbortSignal.timeout(10_000) }),
        fetch(`${GATEWAY}/api/integrations`, { signal: AbortSignal.timeout(10_000) }),
      ]);
      if (availRes.ok) {
        const data = await availRes.json();
        setAvailable(data.services ?? data);
      }
      if (connRes.ok) {
        const data = await connRes.json();
        setConnected(data.connections ?? data);
      }
    } catch (err) {
      setError("Failed to load integrations");
      console.error("Failed to load integrations:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // WebSocket listener for real-time connection updates
  useEffect(() => {
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(getGatewayWs());
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "integration:connected" || msg.type === "integration:disconnected") {
            loadData();
          }
        } catch {
          // not JSON, ignore
        }
      };
      ws.onerror = () => {
        // WebSocket errors are non-fatal; polling fallback handles it
      };
    } catch {
      // WebSocket not available, rely on polling during connect
    }
    return () => {
      ws?.close();
    };
  }, [loadData]);

  const handleConnect = useCallback(async (serviceId: string, label?: string) => {
    setConnecting(serviceId);
    setError(null);
    try {
      const payload: Record<string, string> = { service: serviceId };
      if (label?.trim()) payload.label = label.trim();
      const res = await fetch(`${GATEWAY}/api/integrations/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to start connection");
        setConnecting(null);
        return;
      }
      const { url } = await res.json();
      window.open(url, "_blank", "width=600,height=700");

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
            const hasNew = list.some((c) => !previousIds.has(c.id));
            if (hasNew) {
              setConnected(list);
              setConnecting(null);
              if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
              }
            }
          }
        } catch {
          // keep polling
        }
      }, 2000);

      // Stop polling after 2 minutes
      setTimeout(() => {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setConnecting(null);
        }
      }, 120_000);
    } catch {
      setError("Failed to initiate connection");
      setConnecting(null);
    }
  }, [connected]);

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, []);

  const handleDisconnect = useCallback(async (id: string) => {
    setDisconnecting(id);
    setConfirmDisconnect(null);
    setError(null);
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
    } catch {
      setError("Failed to disconnect service");
    } finally {
      setDisconnecting(null);
    }
  }, []);

  const handleCheckStatus = useCallback(async (id: string) => {
    setCheckingStatus(id);
    setError(null);
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
    } catch {
      setError("Failed to check connection status");
    } finally {
      setCheckingStatus(null);
    }
  }, []);

  const connectedServiceIds = new Set(connected.map((c) => c.service));

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <h2 className="text-lg font-semibold mb-2">Integrations</h2>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-8">
      <div>
        <h2 className="text-lg font-semibold">Integrations</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect external services to extend your agent's capabilities.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Connected Services -- grouped by service */}
      {connected.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Connected
          </h3>
          <div className="space-y-4">
            {Array.from(groupByService(connected)).map(([serviceId, accounts]) => {
              const def = available.find((s) => s.id === serviceId);
              const serviceName = def?.name ?? serviceId;
              const category = def?.category ?? "developer";
              const hasMultiple = accounts.length > 1;
              return (
                <div key={serviceId} className="space-y-1">
                  {hasMultiple && (
                    <div className="flex items-center gap-2 mb-2">
                      <ServiceLogo name={serviceName} category={category} logoUrl={def?.logoUrl} />
                      <span className="text-sm font-medium">{serviceName}</span>
                      <span className="text-xs text-muted-foreground">
                        {accounts.length} accounts
                      </span>
                    </div>
                  )}
                  <div className={`space-y-2 ${hasMultiple ? "ml-12" : ""}`}>
                    {accounts.map((conn) => (
                      <div
                        key={conn.id}
                        className="flex items-center gap-4 rounded-lg border border-border/60 bg-card/50 px-4 py-3"
                      >
                        {!hasMultiple && (
                          <ServiceLogo name={serviceName} category={category} logoUrl={def?.logoUrl} />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            {!hasMultiple && (
                              <span className="text-sm font-medium truncate">
                                {serviceName}
                              </span>
                            )}
                            {hasMultiple && (
                              <span className="text-sm font-medium truncate">
                                {conn.account_label}
                              </span>
                            )}
                            <StatusDot status={conn.status} />
                            <span className="text-xs text-muted-foreground capitalize">
                              {conn.status}
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {!hasMultiple && conn.account_label}
                            {conn.account_email && (hasMultiple ? conn.account_email : ` (${conn.account_email})`)}
                            {" -- "}
                            Connected {formatDate(conn.connected_at)}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={() => handleCheckStatus(conn.id)}
                            disabled={checkingStatus === conn.id}
                            className="rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors disabled:opacity-50"
                          >
                            {checkingStatus === conn.id ? "Checking..." : "Check Status"}
                          </button>
                          {confirmDisconnect === conn.id ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleDisconnect(conn.id)}
                                disabled={disconnecting === conn.id}
                                className="rounded-md bg-red-500/15 border border-red-500/40 px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-500/25 transition-colors disabled:opacity-50"
                              >
                                {disconnecting === conn.id ? "Removing..." : "Confirm"}
                              </button>
                              <button
                                onClick={() => setConfirmDisconnect(null)}
                                className="rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmDisconnect(conn.id)}
                              className="rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-red-400 hover:border-red-500/40 transition-colors"
                            >
                              Disconnect
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Available Services */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Available
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {available.map((service) => {
            const isConnected = connectedServiceIds.has(service.id);
            const isConnecting = connecting === service.id;
            return (
              <div
                key={service.id}
                className="rounded-lg border border-border/60 bg-card/50 p-4 flex flex-col gap-3"
              >
                <div className="flex items-center gap-3">
                  <ServiceLogo name={service.name} category={service.category} logoUrl={service.logoUrl} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{service.name}</div>
                    <div className="text-xs text-muted-foreground capitalize">
                      {service.category}
                    </div>
                  </div>
                </div>
                {isConnected && (
                  <input
                    type="text"
                    placeholder="Label (e.g. Work, Personal)"
                    value={connecting === service.id ? "" : (connectLabels[service.id] ?? "")}
                    onChange={(e) => setConnectLabels((prev) => ({ ...prev, [service.id]: e.target.value }))}
                    disabled={isConnecting}
                    className="w-full rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-xs placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                )}
                <button
                  onClick={() => {
                    handleConnect(service.id, isConnected ? connectLabels[service.id] : undefined);
                    setConnectLabels((prev) => ({ ...prev, [service.id]: "" }));
                  }}
                  disabled={isConnecting}
                  className={`mt-auto w-full rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    isConnecting
                      ? "bg-muted text-muted-foreground cursor-wait"
                      : isConnected
                        ? "border border-border/60 text-muted-foreground hover:bg-foreground/5"
                        : "bg-primary text-primary-foreground hover:bg-primary/90"
                  }`}
                >
                  {isConnecting
                    ? "Connecting..."
                    : isConnected
                      ? "Add Account"
                      : "Connect"}
                </button>
              </div>
            );
          })}
        </div>
        {available.length === 0 && (
          <div className="rounded-lg border border-border/60 bg-card/50 p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No integrations available. Check that the gateway is running.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
