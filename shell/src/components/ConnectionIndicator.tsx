"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnectionHealth } from "@/hooks/useConnectionHealth";
import type { ConnectionState } from "@/hooks/useConnectionHealth";
import { manualReconnect } from "@/hooks/useSocket";
import { getGatewayUrl } from "@/lib/gateway";

const STATUS_REFRESH_MS = 5_000;
const STATUS_TIMEOUT_MS = 4_000;

type GatewayReachability = "checking" | "online" | "unavailable";

interface RuntimeStatus {
  reachability: GatewayReachability;
  releaseVersion?: string | null;
  releaseChannel?: string | null;
}

interface ConnectionCopy {
  tone: "warn" | "danger";
  title: string;
  detail: string;
  action: string;
}

function classifyRuntimeStatusError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return "timeout";
    return "dom_exception";
  }
  if (error instanceof SyntaxError) return "invalid_json";
  if (error instanceof TypeError) return "network_error";
  if (error instanceof Error) return "unexpected_error";
  return "unknown";
}

function logRuntimeStatusError(stage: string, error: unknown): void {
  console.warn(`[connection-indicator] ${stage} failed: ${classifyRuntimeStatusError(error)}`);
}

export function resolveConnectionCopy(state: ConnectionState, status: RuntimeStatus): ConnectionCopy {
  if (state === "disconnected") {
    return {
      tone: "danger",
      title: "Connection lost",
      detail: status.reachability === "online"
        ? "Your Matrix computer is online, but the live shell socket is closed."
        : "Your Matrix computer is not reachable yet. It may be restarting after an update.",
      action: "Reconnect",
    };
  }

  if (status.reachability === "online") {
    const version = status.releaseVersion ? ` ${status.releaseVersion}` : "";
    return {
      tone: "warn",
      title: "Reconnecting shell",
      detail: `The gateway is online${version}. Waiting for the live session to resume.`,
      action: "Retry now",
    };
  }

  if (status.reachability === "checking") {
    return {
      tone: "warn",
      title: "Checking Matrix computer",
      detail: "Matrix is checking whether your computer is restarting or applying an update.",
      action: "Retry now",
    };
  }

  return {
    tone: "warn",
    title: "Matrix computer is restarting",
    detail: "Services are coming back online. This usually happens during bundle upgrades or gateway restarts.",
    action: "Retry now",
  };
}

async function loadRuntimeStatus(): Promise<RuntimeStatus> {
  const gatewayUrl = getGatewayUrl();
  const signal = AbortSignal.timeout(STATUS_TIMEOUT_MS);
  const health = await fetch(`${gatewayUrl}/health`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!health.ok) return { reachability: "unavailable" };

  try {
    const info = await fetch(`${gatewayUrl}/api/system/info`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!info.ok) return { reachability: "online" };
    const body = await info.json() as {
      release?: { version?: string | null; channel?: string | null };
      version?: string | null;
    };
    return {
      reachability: "online",
      releaseVersion: body.release?.version ?? body.version ?? null,
      releaseChannel: body.release?.channel ?? null,
    };
  } catch (err: unknown) {
    logRuntimeStatusError("system-info", err);
    return { reachability: "online" };
  }
}

export function ConnectionIndicator() {
  const state = useConnectionHealth((s) => s.state);
  const [status, setStatus] = useState<RuntimeStatus>({ reachability: "checking" });

  useEffect(() => {
    if (state === "connected") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      void loadRuntimeStatus()
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch((err: unknown) => {
          logRuntimeStatusError("runtime-status", err);
          if (!cancelled) setStatus({ reachability: "unavailable" });
        })
        .finally(() => {
          if (!cancelled) timer = setTimeout(refresh, STATUS_REFRESH_MS);
        });
    };

    setStatus({ reachability: "checking" });
    refresh();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [state]);

  const copy = useMemo(() => resolveConnectionCopy(state, status), [state, status]);
  const toneClass = copy.tone === "danger" ? "text-red-500" : "text-yellow-500";
  const dotClass = copy.tone === "danger" ? "bg-red-500" : "bg-yellow-500";

  if (state === "connected") return null;

  return (
    <aside
      className="pointer-events-none fixed inset-0 z-[90] flex items-center justify-center bg-background/70 px-4 backdrop-blur-md"
      aria-label="Matrix connection status"
      role="status"
    >
      <div className="pointer-events-auto w-full max-w-sm rounded-md border border-border bg-card/95 p-4 text-card-foreground shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
        <div className="flex items-start gap-3">
          <span className={`mt-1 size-2.5 shrink-0 rounded-full ${dotClass} ${state === "reconnecting" ? "animate-pulse" : ""}`} />
          <div className="min-w-0 flex-1">
            <div className={`text-sm font-semibold ${toneClass}`}>{copy.title}</div>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{copy.detail}</p>
            {status.releaseChannel && (
              <p className="mt-2 text-xs text-muted-foreground">
                Channel <span className="font-mono">{status.releaseChannel}</span>
              </p>
            )}
            <button
              className="mt-4 inline-flex min-h-8 items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition hover:bg-muted"
              onClick={manualReconnect}
              type="button"
            >
              {copy.action}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
