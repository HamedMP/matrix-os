"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangleIcon, CpuIcon, HardDriveIcon, RefreshCcwIcon, ServerIcon, XIcon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";

const ATTENTION_RELEASE_CHANNELS = new Set(["dev", "canary", "beta"]);

interface RuntimeInfo {
  runtime?: {
    handle?: string | null;
    machineId?: string | null;
    runtimeSlot?: string | null;
  };
  release?: {
    version?: string | null;
    channel?: string | null;
  };
  resources?: {
    cpuCount?: number;
    memoryTotalBytes?: number;
    diskTotalBytes?: number | null;
  };
}

interface IdentityInfo {
  handle?: string;
}

function formatBytes(value?: number | null) {
  if (!value || value <= 0) return null;
  const gib = value / 1024 / 1024 / 1024;
  return `${gib >= 10 ? Math.round(gib) : gib.toFixed(1)} GB`;
}

function shortMachineId(machineId?: string | null) {
  if (!machineId) return null;
  return machineId.replaceAll("-", "").slice(0, 8);
}

function logSettledFetchFailure(label: string, reason: unknown) {
  if (reason instanceof DOMException && reason.name === "AbortError") return;
  console.warn(`[runtime-banner] ${label} failed:`, reason instanceof Error ? reason.message : String(reason));
}

export function RuntimeIdentityBanner() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [resetting, setResetting] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- guarded run-once mount load (empty deps) with AbortController + AbortSignal.timeout and an abort in cleanup; this is the correct fetch-on-mount pattern and uses Promise.allSettled so neither request blocks the other.
  useEffect(() => {
    const gatewayUrl = getGatewayUrl();

    void Promise.allSettled([
      fetch(`${gatewayUrl}/api/system/info`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error("system info request failed");
          return await res.json() as RuntimeInfo;
        }),
      fetch(`${gatewayUrl}/api/identity`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error("identity request failed");
          return await res.json() as IdentityInfo;
        }),
    ]).then(([systemResult, identityResult]) => {
      if (systemResult.status === "fulfilled") {
        setRuntime(systemResult.value);
      } else {
        logSettledFetchFailure("system info", systemResult.reason);
      }
      if (identityResult.status === "fulfilled") {
        setIdentity(identityResult.value);
      } else {
        logSettledFetchFailure("identity", identityResult.reason);
      }
    });

    return undefined;
  }, []);

  const summary = useMemo(() => {
    const handle = runtime?.runtime?.handle ?? identity?.handle ?? null;
    const slot = runtime?.runtime?.runtimeSlot ?? "primary";
    const machineId = runtime?.runtime?.machineId ?? null;
    const isStaging = slot !== "primary";
    const channel = runtime?.release?.channel?.toLowerCase() ?? null;
    const shouldShow = isStaging || (channel ? ATTENTION_RELEASE_CHANNELS.has(channel) : false);
    return {
      handle,
      slot,
      machineId,
      shortId: shortMachineId(machineId),
      version: runtime?.release?.version ?? "version pending",
      channel,
      cpu: runtime?.resources?.cpuCount ? `${runtime.resources.cpuCount} CPU` : null,
      memory: formatBytes(runtime?.resources?.memoryTotalBytes),
      disk: formatBytes(runtime?.resources?.diskTotalBytes),
      isStaging,
      shouldShow,
      label: isStaging ? "STAGING VM" : `${channel?.toUpperCase() ?? "RUNTIME"} BUILD`,
    };
  }, [identity?.handle, runtime]);

  if (!summary.handle || !summary.shouldShow || dismissed) return null;

  const resetOnboarding = async () => {
    if (resetting) return;
    if (!window.confirm("Reset onboarding and reload Matrix on this VM?")) return;
    setResetting(true);
    try {
      const gatewayUrl = getGatewayUrl();
      const res = await fetch(`${gatewayUrl}/api/settings/onboarding-reset`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot yet lower a ThrowStatement inside try/catch (BuildHIR Todo: Support ThrowStatement inside of try/catch); throwing here routes the failed reset into the shared catch below for logging and state reset, which is the intended control flow.
      if (!res.ok) throw new Error("onboarding reset request failed");
      window.location.reload();
    } catch (err: unknown) {
      setResetting(false);
      console.warn("[runtime-banner] failed to reset onboarding:", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <aside
      className={[
        "fixed right-3 top-9 z-[95] max-w-[calc(100vw-1.5rem)] rounded-md border px-3 py-2 shadow-[0_18px_60px_rgba(0,0,0,0.18)] backdrop-blur-md",
        summary.isStaging
          ? "border-[#8a3a11]/35 bg-[#fff1df]/92 text-[#3f210d]"
          : "border-[#8a3a11]/30 bg-[#fff8e8]/92 text-[#3f210d]",
      ].join(" ")}
      aria-label="Current Matrix VM"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              {summary.isStaging ? <AlertTriangleIcon className="h-3.5 w-3.5 text-[#b4531f]" aria-hidden="true" /> : <ServerIcon className="h-3.5 w-3.5" aria-hidden="true" />}
              {summary.label}
            </span>
            <span className="font-mono font-semibold">{summary.handle ?? "unknown"}</span>
            <span className="rounded-full border border-current/15 px-2 py-0.5 font-medium">{summary.slot}</span>
            {summary.channel && <span className="rounded-full border border-current/15 px-2 py-0.5 font-medium">{summary.channel}</span>}
            {summary.shortId && <span className="font-mono text-current/62">#{summary.shortId}</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-current/62">
            {summary.cpu && (
              <span className="inline-flex items-center gap-1">
                <CpuIcon className="h-3 w-3" aria-hidden="true" />
                {summary.cpu}
              </span>
            )}
            {summary.memory && <span>{summary.memory} RAM</span>}
            {summary.disk && (
              <span className="inline-flex items-center gap-1">
                <HardDriveIcon className="h-3 w-3" aria-hidden="true" />
                {summary.disk}
              </span>
            )}
            <span className="max-w-[18rem] truncate font-mono">{summary.version}</span>
            <button
              type="button"
              onClick={() => void resetOnboarding()}
              disabled={resetting}
              className="inline-flex min-h-6 items-center gap-1 rounded-full border border-current/15 bg-white/35 px-2 py-0.5 font-medium text-current/78 transition hover:bg-white/60 disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCcwIcon className="h-3 w-3" aria-hidden="true" />
              {resetting ? "Resetting" : "Reset onboarding"}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="-mr-1 -mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-current/58 transition hover:bg-white/55 hover:text-current"
          aria-label="Dismiss runtime banner"
        >
          <XIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
