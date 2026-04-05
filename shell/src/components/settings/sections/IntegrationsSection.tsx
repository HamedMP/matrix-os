"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getGatewayUrl, getGatewayWs } from "@/lib/gateway";

const GATEWAY = getGatewayUrl();

interface ServiceDef {
  id: string;
  name: string;
  category: string;
  icon: string;
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

function ServiceInitial({ name, category }: { name: string; category: string }) {
  const bg = CATEGORY_COLORS[category] ?? "bg-primary";
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

export function IntegrationsSection() {
  const [available, setAvailable] = useState<ServiceDef[]>([]);
  const [connected, setConnected] = useState<ConnectedService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
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

  const handleConnect = useCallback(async (serviceId: string) => {
    setConnecting(serviceId);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY}/api/integrations/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: serviceId }),
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

      // Poll for new connection every 2s
      const previousIds = new Set(connected.map((c) => c.id));
      pollRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch(`${GATEWAY}/api/integrations`, {
            signal: AbortSignal.timeout(10_000),
          });
          if (pollRes.ok) {
            const data = await pollRes.json();
            const list: ConnectedService[] = data.connections ?? data;
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

      {/* Connected Services */}
      {connected.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Connected
          </h3>
          <div className="space-y-2">
            {connected.map((conn) => {
              const def = available.find((s) => s.id === conn.service);
              return (
                <div
                  key={conn.id}
                  className="flex items-center gap-4 rounded-lg border border-border/60 bg-card/50 px-4 py-3"
                >
                  <ServiceInitial
                    name={def?.name ?? conn.service}
                    category={def?.category ?? "developer"}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {def?.name ?? conn.service}
                      </span>
                      <StatusDot status={conn.status} />
                      <span className="text-xs text-muted-foreground capitalize">
                        {conn.status}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {conn.account_label}
                      {conn.account_email && ` (${conn.account_email})`}
                      {" -- "}
                      Connected {formatDate(conn.connected_at)}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDisconnect(conn.id)}
                    disabled={disconnecting === conn.id}
                    className="shrink-0 rounded-md border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-red-400 hover:border-red-500/40 transition-colors disabled:opacity-50"
                  >
                    {disconnecting === conn.id ? "Disconnecting..." : "Disconnect"}
                  </button>
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
                  <ServiceInitial name={service.name} category={service.category} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{service.name}</div>
                    <div className="text-xs text-muted-foreground capitalize">
                      {service.category}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleConnect(service.id)}
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
                      ? "Connect Another"
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
