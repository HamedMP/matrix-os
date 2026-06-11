"use client";

import { useEffect, useState } from "react";
import { useConnectionHealth } from "@/hooks/useConnectionHealth";
import { manualReconnect } from "@/hooks/useSocket";
import { getGatewayUrl } from "@/lib/gateway";
import { resolveConnectionCopy, type RuntimeStatus } from "./connection-indicator-copy";

const STATUS_REFRESH_MS = 5_000;
const STATUS_TIMEOUT_MS = 4_000;

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
  const [status, setStatus] = useState<RuntimeStatus>({ reachability: "checking" });

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- polling loop: every setStatus call fires either synchronously to reset the gauge on disconnect or from async fetch/timer callbacks (never a synchronous cascade); a reducer would not change the self-rescheduling sequencing and the cancelled flag guards post-unmount writes.
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

    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- resets the gauge to "checking" each time the connection leaves "connected", before the async loadRuntimeStatus poll resolves; reflects live runtime reachability, not derivable in render.
    setStatus({ reachability: "checking" });
    refresh();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [state]);

  const copy = resolveConnectionCopy(state, status);
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
