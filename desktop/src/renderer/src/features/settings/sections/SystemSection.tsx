import { useEffect, useState } from "react";
import { readSystemVersionIdentity } from "../../../lib/system-version";
import { useConnection } from "../../../stores/connection";
import { Card, Empty, Row, SectionHeader } from "./section-kit";

interface SystemInfo {
  version?: unknown;
  runningVersion?: unknown;
  uptime?: number;
  runtime?: { handle?: string; runtimeSlot?: string; machineId?: string };
  resources?: { cpuCount?: number; memoryTotal?: number; memoryFree?: number; diskTotal?: number; diskFree?: number };
  release?: { version?: string; channel?: string };
}

function gb(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "–";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export default function SystemSection() {
  const api = useConnection((s) => s.api);
  const [state, setState] = useState<{ info: SystemInfo | null; error: boolean }>({
    info: null,
    error: false,
  });

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .get<SystemInfo>("/api/system/info")
      .then((d) => {
        if (!cancelled) {
          setState({ info: d, error: false });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn(
          "[settings] load system info failed:",
          err instanceof Error ? err.message : String(err),
        );
        setState((current) => ({ ...current, error: true }));
      });
    return () => { cancelled = true; };
  }, [api]);

  const { installedVersion, runningVersion } = readSystemVersionIdentity(state.info);
  const versionMismatch = Boolean(
    installedVersion && runningVersion && installedVersion !== runningVersion,
  );

  return (
    <>
      <SectionHeader title="System" description="Your cloud computer at a glance." />
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
