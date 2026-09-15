import { useEffect, useRef, useState } from "react";
import { readSystemVersionIdentity } from "../../../lib/system-version";
import { useConnection } from "../../../stores/connection";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../../stores/runtime-generation";
import { Card, Empty, Row, SettingsSectionHeader } from "./section-kit";

interface SystemInfo {
  version?: unknown;
  runningVersion?: unknown;
  updateChannel?: string;
  runtime?: { handle?: string; runtimeSlot?: string; machineId?: string };
  resources?: { cpuCount?: number; memoryTotal?: number; memoryFree?: number; diskTotal?: number; diskFree?: number };
  release?: { version?: string; channel?: string; gitCommit?: string; buildTime?: string };
}

function gb(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "–";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export default function SystemSection() {
  const api = useConnection((s) => s.api);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const [state, setState] = useState<{ info: SystemInfo | null; error: boolean }>({ info: null, error: false });
  const systemInfoRequestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const request = ++systemInfoRequestRef.current;
    const runtimeGeneration = captureRuntimeGeneration();
    setState({ info: null, error: false });
    if (!api) return () => { cancelled = true; };
    api.get<SystemInfo>("/api/system/info").then((info) => {
      if (cancelled || request !== systemInfoRequestRef.current || !isCurrentRuntimeGeneration(runtimeGeneration)) return;
      setState({ info, error: false });
    }).catch((err: unknown) => {
      if (cancelled || request !== systemInfoRequestRef.current || !isCurrentRuntimeGeneration(runtimeGeneration)) return;
      console.warn("[settings] load system info failed:", err instanceof Error ? err.message : String(err));
      setState((current) => ({ ...current, error: true }));
    });
    return () => { cancelled = true; };
  }, [api, runtimeSlot]);

  const info = state.info;
  const { installedVersion, runningVersion } = readSystemVersionIdentity(info);
  const versionMismatch = Boolean(
    installedVersion && runningVersion && installedVersion !== runningVersion,
  );

  return (
    <>
      <SettingsSectionHeader title="System" description="Your cloud computer at a glance." />
      <Card>
        {state.error ? <Empty text="System info unavailable." /> : (
          <>
            <Row label="Installed version" value={installedVersion ?? "–"} />
            <Row label="Running version" value={runningVersion ?? "–"} />
            {versionMismatch ? (
              <p role="status" className="text-sm" style={{ color: "var(--warning)" }}>
                The running services do not match the installed update. Restart Matrix services to finish applying it.
              </p>
            ) : null}
            <Row label="Update channel" value={state.info?.updateChannel ?? "–"} />
            <Row label="Release channel" value={state.info?.release?.channel ?? "–"} />
            <Row label="Machine" value={state.info?.runtime?.machineId ?? state.info?.runtime?.handle ?? "–"} />
            <Row label="CPU cores" value={state.info?.resources?.cpuCount ?? "–"} />
            <Row label="Memory free" value={`${gb(state.info?.resources?.memoryFree)} of ${gb(state.info?.resources?.memoryTotal)}`} />
            <Row label="Disk free" value={`${gb(state.info?.resources?.diskFree)} of ${gb(state.info?.resources?.diskTotal)}`} />
          </>
        )}
      </Card>
    </>
  );
}
