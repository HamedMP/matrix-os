"use client";

import { useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { useConnectionHealth } from "@/hooks/useConnectionHealth";
import { manualReconnect } from "@/hooks/useSocket";
import { getGatewayUrl } from "@/lib/gateway";
import { resolveConnectionCopy, type RuntimeStatus } from "./connection-indicator-copy";
import { ShellNotificationCard } from "./ShellNotificationCard";

const STATUS_REFRESH_MS = 5_000;
const STATUS_TIMEOUT_MS = 1_500;
const INITIAL_CONNECTION_GRACE_MS = 2_500;

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
  if (process.env.NODE_ENV !== "production") {
    console.debug(`[connection-indicator] ${stage} failed: ${classifyRuntimeStatusError(error)}`);
  }
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
  const hasConnected = useConnectionHealth((s) => s.hasConnected);
  const reconnectQuietElapsed = useConnectionHealth((s) => s.reconnectQuietElapsed);
  const [status, setStatus] = useState<RuntimeStatus>({ reachability: "checking" });
  const [initialGraceElapsed, setInitialGraceElapsed] = useState(false);

  useEffect(() => {
    if (state !== "initializing") {
      return;
    }
    const timer = setTimeout(() => setInitialGraceElapsed(true), INITIAL_CONNECTION_GRACE_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const suppressReconnectStatus =
    state === "reconnecting" && hasConnected && !reconnectQuietElapsed;

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- polling loop: every setStatus call fires either synchronously to reset the gauge on disconnect or from async fetch/timer callbacks (never a synchronous cascade); a reducer would not change the self-rescheduling sequencing and the cancelled flag guards post-unmount writes.
  useEffect(() => {
    if (state === "connected") return;
    if (state === "initializing" && !initialGraceElapsed) return;
    if (suppressReconnectStatus) return;
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

    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- resets the gauge to "checking" each time the connection leaves "connected", before the async loadRuntimeStatus poll resolves; reflects live runtime reachability, not derivable in render.
    setStatus({ reachability: "checking" });
    refresh();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [initialGraceElapsed, state, suppressReconnectStatus]);

  const copy = resolveConnectionCopy(state, status);
  const toneClass = copy.tone === "danger" ? "text-red-500" : "text-amber-500";
  const dotClass = copy.tone === "danger" ? "bg-red-500 shadow-[0_0_0_4px_rgba(239,68,68,0.14)]" : "bg-amber-400 shadow-[0_0_0_4px_rgba(245,158,11,0.16)]";
  const panelClass = copy.tone === "danger"
    ? "border-red-500/25 bg-card/95 shadow-[0_18px_60px_-24px_rgba(239,68,68,0.58),0_24px_60px_-30px_rgba(0,0,0,0.38)]"
    : "border-amber-500/20 bg-card/95 shadow-[0_18px_60px_-24px_rgba(245,158,11,0.45),0_24px_60px_-30px_rgba(0,0,0,0.34)]";

  if (
    state === "connected"
    || (state === "initializing" && !initialGraceElapsed)
    || suppressReconnectStatus
  ) return null;

  return (
    <ShellNotificationCard
      className={`flex flex-col gap-3 rounded-2xl border px-3.5 py-3 text-card-foreground backdrop-blur-md backdrop-saturate-150 sm:flex-row sm:items-center sm:gap-4 ${panelClass}`}
      aria-label="Matrix connection status"
      data-variant="toast"
      role="status"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          className={`mt-2 size-2.5 shrink-0 rounded-full ${dotClass} ${state === "reconnecting" ? "animate-pulse" : ""}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-semibold leading-5 ${toneClass}`}>{copy.title}</div>
          <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{copy.detail}</p>
          {(status.releaseChannel || status.releaseVersion) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/80">
              {status.releaseChannel && (
                <span className="rounded-full border border-border/50 bg-background/50 px-2 py-0.5 font-mono">
                  {status.releaseChannel}
                </span>
              )}
              {status.releaseVersion && <span className="truncate font-mono">{status.releaseVersion}</span>}
            </div>
          )}
        </div>
      </div>
      <button
        className="inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-3 text-sm font-medium text-foreground transition hover:border-border hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={manualReconnect}
        type="button"
      >
        <RefreshCwIcon className="size-3.5" aria-hidden="true" />
        {copy.action}
      </button>
    </ShellNotificationCard>
  );
}
