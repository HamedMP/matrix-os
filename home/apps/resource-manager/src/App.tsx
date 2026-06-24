import { useCallback, useEffect, useMemo, useState } from "react";

const ACTIVITY_URL = "/api/system/activity?processLimit=25&includeSuggestions=true";
const SAFE_ERROR = "Resource data is unavailable.";

type HealthStatus = "healthy" | "degraded" | "unknown";
type ServiceState = "running" | "starting" | "stopped" | "failed" | "unknown";

interface ActivitySnapshot {
  generatedAt: string;
  machine: {
    handle: string | null;
    runtimeSlot: string;
    hostname: string;
    status: HealthStatus;
    releaseVersion?: string;
    releaseChannel?: string;
    uptimeSeconds: number;
  };
  resources: {
    cpu: { cores: number; load1: number; load5: number; load15: number };
    memory: {
      totalBytes: number;
      usedBytes: number;
      availableBytes: number;
      processRssBytes: number;
    };
    swap: { totalBytes: number; usedBytes: number };
    disk: Array<{ mount: string; label: string; usedBytes: number; totalBytes: number; usedPercent: number }>;
  };
  services: Array<{
    serviceId: string;
    state: ServiceState;
    memoryBytes?: number;
    cpuSeconds?: number;
    tasks?: number;
    restartCount?: number;
  }>;
  processes: Array<{
    processRef: string;
    pid?: number;
    ownerClass: "matrix" | "root" | "system" | "unknown";
    classification: string;
    displayName: string;
    cpuPercent: number;
    rssBytes: number;
    elapsedSeconds: number;
    ports: number[];
    activeConnections?: number;
  }>;
  cleanupSuggestions: Array<{
    candidateId: string;
    type: string;
    targetLabel: string;
    reason: string;
    confidence: "high" | "medium" | "manual_review";
    risk: "low" | "medium" | "high";
    estimatedReclaimBytes?: number;
    requiresConfirmation: boolean;
    confirmationToken: string;
    expiresAt: string;
  }>;
  collectionWarnings: string[];
}

type RefreshStatus = "idle" | "loading" | "success" | "error";

async function fetchActivity(): Promise<ActivitySnapshot> {
  if (!window.MatrixOS?.gatewayFetch) throw new Error("matrix_bridge_unavailable");
  return await window.MatrixOS.gatewayFetch<ActivitySnapshot>(ACTIVITY_URL, { method: "GET" }, 10_000);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const fractionDigits = Number.isInteger(value) || value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(fractionDigits)} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unknown";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function statusTone(status: HealthStatus | ServiceState | string): string {
  if (status === "healthy" || status === "running") return "tone-good";
  if (status === "starting" || status === "degraded" || status === "medium") return "tone-warn";
  if (status === "failed" || status === "high") return "tone-bad";
  return "tone-muted";
}

function percent(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)));
}

function Bar({ value, label }: { value: number; label: string }) {
  return (
    <div className="bar-wrap" aria-label={label}>
      <div className="bar" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function MetricCard({ label, value, detail, bar }: { label: string; value: string; detail: string; bar?: number }) {
  return (
    <section className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-detail">{detail}</div>
      {bar !== undefined ? <Bar value={bar} label={`${label} usage`} /> : null}
    </section>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot | null>(null);
  const [status, setStatus] = useState<RefreshStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const next = await fetchActivity();
      setSnapshot(next);
      setStatus("success");
    } catch (err) {
      console.warn("[resource-manager] activity refresh failed:", err instanceof Error ? err.message : String(err));
      setStatus("error");
      setError(SAFE_ERROR);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const topProcesses = useMemo(
    () => (snapshot?.processes ?? []).slice().sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 8),
    [snapshot?.processes],
  );

  const failedServices = snapshot?.services.filter((service) => service.state === "failed").length ?? 0;
  const runningServices = snapshot?.services.filter((service) => service.state === "running").length ?? 0;
  const memoryPercent = snapshot ? percent(snapshot.resources.memory.usedBytes, snapshot.resources.memory.totalBytes) : 0;
  const swapPercent = snapshot ? percent(snapshot.resources.swap.usedBytes, snapshot.resources.swap.totalBytes) : 0;
  const primaryDisk = snapshot?.resources.disk[0] ?? null;

  return (
    <main className="resource-app">
      <header className="topbar">
        <div className="mark" aria-hidden="true">RM</div>
        <div className="title-block">
          <h1>Resource Manager</h1>
          <p>{snapshot ? `${snapshot.machine.hostname} · uptime ${formatDuration(snapshot.machine.uptimeSeconds)}` : "Live system activity"}</p>
        </div>
        <button className="refresh-button" type="button" onClick={() => void refresh()} disabled={status === "loading"}>
          Refresh
        </button>
      </header>

      {error ? <div className="notice error">{error}</div> : null}

      <section className="machine-strip">
        <div>
          <span className="eyebrow">Machine</span>
          <strong>{snapshot?.machine.handle ?? "Unknown"}</strong>
        </div>
        <div>
          <span className="eyebrow">Health</span>
          <strong className={`pill ${statusTone(snapshot?.machine.status ?? "unknown")}`}>{snapshot?.machine.status ?? "unknown"}</strong>
        </div>
        <div>
          <span className="eyebrow">Runtime</span>
          <strong>{snapshot?.machine.runtimeSlot ?? "Unavailable"}</strong>
        </div>
        <div>
          <span className="eyebrow">Release</span>
          <strong>{snapshot?.machine.releaseVersion ? `Release ${snapshot.machine.releaseVersion}` : "Not reported"}</strong>
        </div>
      </section>

      <section className="metrics-grid" aria-label="Resource summary">
        <MetricCard
          label="CPU"
          value={snapshot ? `${snapshot.resources.cpu.load1.toFixed(2)} load` : "Loading"}
          detail={snapshot ? `${snapshot.resources.cpu.cores} cores` : "Waiting for data"}
          bar={snapshot ? percent(snapshot.resources.cpu.load1, snapshot.resources.cpu.cores) : 0}
        />
        <MetricCard
          label="Memory"
          value={snapshot ? `${formatBytes(snapshot.resources.memory.usedBytes)} / ${formatBytes(snapshot.resources.memory.totalBytes)}` : "Loading"}
          detail={snapshot ? `${formatBytes(snapshot.resources.memory.availableBytes)} available` : "Waiting for data"}
          bar={memoryPercent}
        />
        <MetricCard
          label="Swap"
          value={snapshot ? `${formatBytes(snapshot.resources.swap.usedBytes)} / ${formatBytes(snapshot.resources.swap.totalBytes)}` : "Loading"}
          detail="Kernel overflow pressure"
          bar={swapPercent}
        />
        <MetricCard
          label="Disk"
          value={primaryDisk ? `${primaryDisk.usedPercent}% used` : "Loading"}
          detail={primaryDisk ? `${primaryDisk.label} on ${primaryDisk.mount}` : "Waiting for data"}
          bar={primaryDisk?.usedPercent ?? 0}
        />
      </section>

      <section className="content-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>Services</h2>
            <span>{runningServices} running · {failedServices} failed</span>
          </div>
          <div className="service-list">
            {(snapshot?.services ?? []).map((service) => (
              <div className="service-row" key={service.serviceId}>
                <div>
                  <strong>{service.serviceId}</strong>
                  <span>{formatBytes(service.memoryBytes ?? 0)} · restarts {service.restartCount ?? 0}</span>
                </div>
                <span className={`pill ${statusTone(service.state)}`}>{service.state}</span>
              </div>
            ))}
            {snapshot && snapshot.services.length === 0 ? <p className="empty">No managed services reported.</p> : null}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <h2>Processes</h2>
            <span>Top CPU</span>
          </div>
          <div className="process-list">
            {topProcesses.map((process) => (
              <div className="process-row" key={process.processRef}>
                <div className="process-main">
                  <strong>{process.displayName}</strong>
                  <span>{process.classification} · {process.ownerClass} · pid {process.pid ?? "?"}</span>
                </div>
                <div className="process-stats">
                  <strong>{process.cpuPercent.toFixed(1)}%</strong>
                  <span>{formatBytes(process.rssBytes)}</span>
                </div>
              </div>
            ))}
            {snapshot && topProcesses.length === 0 ? <p className="empty">No process samples reported.</p> : null}
          </div>
        </section>
      </section>

      <section className="content-grid bottom-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>Cleanup Suggestions</h2>
            <span>{snapshot?.cleanupSuggestions.length ?? 0}</span>
          </div>
          <div className="suggestion-list">
            {(snapshot?.cleanupSuggestions ?? []).map((suggestion) => (
              <div className="suggestion-row" key={suggestion.candidateId}>
                <div>
                  <strong>{suggestion.targetLabel}</strong>
                  <span>{suggestion.reason}</span>
                </div>
                <span className={`pill ${statusTone(suggestion.risk)}`}>
                  {suggestion.estimatedReclaimBytes ? formatBytes(suggestion.estimatedReclaimBytes) : suggestion.risk}
                </span>
              </div>
            ))}
            {snapshot && snapshot.cleanupSuggestions.length === 0 ? <p className="empty">No cleanup suggestions right now.</p> : null}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <h2>Warnings</h2>
            <span>{snapshot?.collectionWarnings.length ?? 0}</span>
          </div>
          <div className="warning-list">
            {(snapshot?.collectionWarnings ?? []).map((warning) => (
              <div className="notice" key={warning}>{warning}</div>
            ))}
            {snapshot && snapshot.collectionWarnings.length === 0 ? <p className="empty">No collection warnings.</p> : null}
            {!snapshot && status === "loading" ? <p className="empty">Loading activity data...</p> : null}
          </div>
        </section>
      </section>
    </main>
  );
}
