import { Activity, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { EmptyState, IconButton, StatusDot } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";

const POLL_MS = 5000;

const ProcessSchema = z.object({
  processRef: z.string(),
  pid: z.number().optional(),
  classification: z.string().optional(),
  displayName: z.string().optional(),
  cpuPercent: z.number().optional(),
  rssBytes: z.number().optional(),
  ports: z.array(z.union([z.number(), z.string(), z.record(z.string(), z.unknown())])).optional(),
});
const ServiceSchema = z.object({ name: z.string(), status: z.string().optional() });
const SnapshotSchema = z.object({
  resources: z
    .object({
      cpu: z.object({ cores: z.number().optional(), load1: z.number().optional() }).optional(),
      memory: z.object({ totalBytes: z.number().optional(), usedBytes: z.number().optional() }).optional(),
    })
    .optional(),
  services: z.array(ServiceSchema).optional(),
  processes: z.array(ProcessSchema).optional(),
});
type Snapshot = z.infer<typeof SnapshotSchema>;

/** Human byte size (e.g. 1.5 GB) from a byte count. */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const rounded = value >= 10 || i === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
}

function portList(ports: unknown[] | undefined): string {
  if (!ports || ports.length === 0) return "";
  const nums = ports
    .map((p) => (typeof p === "number" ? p : typeof p === "object" && p && "port" in p ? (p as { port: unknown }).port : null))
    .filter((p): p is number => typeof p === "number");
  return nums.length ? nums.join(", ") : "";
}

const SERVICE_OK = new Set(["running", "active", "ok", "healthy"]);

export default function ProcessesPanel() {
  const api = useConnection((s) => s.api);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);

  const load = async (isCancelled: () => boolean = () => false) => {
    if (!api || inFlight.current) return;
    inFlight.current = true;
    const cancelled = () => !mounted.current || isCancelled();
    try {
      const raw = await api.get<unknown>("/api/system/activity?processLimit=25");
      if (cancelled()) return;
      const parsed = SnapshotSchema.safeParse(raw);
      setSnapshot(parsed.success ? parsed.data : {});
      setError(parsed.success ? null : "Unexpected response.");
    } catch (err: unknown) {
      if (cancelled()) return;
      setError(toUserMessage(err));
      setSnapshot((prev) => prev ?? {});
    } finally {
      inFlight.current = false;
    }
  };

  useEffect(() => {
    if (!api) return;
    mounted.current = true;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void load(() => cancelled);
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      mounted.current = false;
      inFlight.current = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  if (snapshot === null) {
    return <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--text-tertiary)" }}>Loading processes…</div>;
  }

  const processes = (snapshot.processes ?? []).slice().sort((a, b) => (b.rssBytes ?? 0) - (a.rssBytes ?? 0));
  const mem = snapshot.resources?.memory;
  const cpu = snapshot.resources?.cpu;
  const services = snapshot.services ?? [];

  if (processes.length === 0 && services.length === 0) {
    return (
      <EmptyState
        icon={<Activity size={22} />}
        headline="No process data"
        description={error ?? "Nothing running to report on this machine right now."}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
        <div className="flex items-center gap-3">
          {cpu ? <span>CPU load {cpu.load1?.toFixed(2) ?? "—"}{cpu.cores ? ` / ${cpu.cores}` : ""}</span> : null}
          {mem ? <span>Mem {formatBytes(mem.usedBytes)} / {formatBytes(mem.totalBytes)}</span> : null}
        </div>
        <IconButton label="Refresh processes" onClick={() => void load()}>
          <RefreshCw size={12} />
        </IconButton>
      </div>

      {services.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-b px-3 py-2" style={{ borderColor: "var(--border-subtle)" }}>
          {services.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
              <StatusDot color={SERVICE_OK.has((s.status ?? "").toLowerCase()) ? "var(--success)" : "var(--warning)"} />
              {s.name.replace(/^matrix-/, "")}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        {processes.map((p) => {
          const ports = portList(p.ports);
          return (
            <div key={p.processRef} className="flex items-center gap-3 border-b px-3 py-1.5 text-xs" style={{ borderColor: "var(--border-subtle)" }}>
              <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text-primary)" }}>
                {p.displayName ?? p.classification ?? `pid ${p.pid ?? "?"}`}
              </span>
              {ports ? <span className="font-mono" style={{ color: "var(--highlight)" }}>:{ports}</span> : null}
              <span className="tabular-nums" style={{ color: "var(--text-tertiary)" }}>{(p.cpuPercent ?? 0).toFixed(0)}%</span>
              <span className="w-14 text-right tabular-nums" style={{ color: "var(--text-tertiary)" }}>{formatBytes(p.rssBytes)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
