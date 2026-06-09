"use client";

import { useEffect, type ReactNode } from "react";
import {
  Activity,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Server,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { useSystemActivityStore, type ActivitySnapshot } from "@/stores/systemActivityStore";
import { CleanupSuggestions } from "./CleanupSuggestions";

export function ActivityMonitorApp() {
  const snapshot = useSystemActivityStore((state) => state.snapshot);
  const refreshStatus = useSystemActivityStore((state) => state.refreshStatus);
  const cleanupStatus = useSystemActivityStore((state) => state.cleanupStatus);
  const error = useSystemActivityStore((state) => state.error);
  const cleanupMessage = useSystemActivityStore((state) => state.cleanupMessage);
  const refresh = useSystemActivityStore((state) => state.refresh);
  const runCleanup = useSystemActivityStore((state) => state.runCleanup);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const loading = refreshStatus === "loading" && !snapshot;

  return (
    <div className="h-full min-h-0 overflow-auto bg-[#f7f8fa] text-[#14171f] dark:bg-[#090b10] dark:text-[#f2f5f8]">
      <div className="mx-auto grid min-h-full w-full max-w-[1180px] content-start gap-4 p-4 sm:p-5">
        <header className="grid gap-3 border-b border-black/10 pb-4 dark:border-white/10 md:grid-cols-[1fr_auto] md:items-end">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-emerald-700 dark:text-emerald-300">
              <Activity className="size-3.5" />
              <span>System Activity</span>
            </div>
            <h1 className="truncate text-2xl font-semibold tracking-normal sm:text-3xl">
              {snapshot?.machine.hostname ?? "Matrix computer"}
            </h1>
            <p className="mt-1 truncate text-sm text-[#5a6272] dark:text-[#9aa4b6]">
              {machineSubtitle(snapshot)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <StatusPill status={snapshot?.machine.status ?? (error ? "degraded" : "unknown")} />
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-black/10 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-[#eef3f7] disabled:opacity-60 dark:border-white/10 dark:bg-[#141922] dark:hover:bg-[#1d2530]"
              disabled={refreshStatus === "loading"}
            >
              <RefreshCw className={`size-4 ${refreshStatus === "loading" ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </header>

        {error && (
          <div className="rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-100">
            {error}
          </div>
        )}

        {loading ? (
          <ActivitySkeleton />
        ) : snapshot ? (
          <main className="grid gap-4">
            <ResourceStrip snapshot={snapshot} />
            <section className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
              <div className="grid gap-4">
                <Panel title="Services" icon={<Server className="size-4" />}>
                  <ServiceGrid services={snapshot.services} />
                </Panel>
                <Panel title="Top Processes" icon={<Cpu className="size-4" />}>
                  <ProcessTable processes={snapshot.processes} />
                </Panel>
              </div>
              <div className="grid gap-4 content-start">
                <Panel title="Cleanup" icon={<ShieldCheck className="size-4" />}>
                  <CleanupSuggestions
                    suggestions={snapshot.cleanupSuggestions}
                    cleanupStatus={cleanupStatus}
                    onRun={runCleanup}
                  />
                  {cleanupMessage && (
                    <p className={`mt-3 rounded-md px-3 py-2 text-sm ${cleanupStatus === "error"
                      ? "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-100"
                      : "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"}`}>
                      {cleanupMessage}
                    </p>
                  )}
                </Panel>
                <Panel title="Signals" icon={<Gauge className="size-4" />}>
                  <SignalList snapshot={snapshot} />
                </Panel>
              </div>
            </section>
          </main>
        ) : (
          <div className="grid min-h-[320px] place-items-center rounded-md border border-dashed border-black/15 bg-white/70 p-6 text-center dark:border-white/15 dark:bg-white/5">
            <div>
              <Activity className="mx-auto mb-3 size-8 text-[#5b8def]" />
              <h2 className="text-lg font-semibold">Activity data unavailable</h2>
              <p className="mt-1 text-sm text-[#5a6272] dark:text-[#9aa4b6]">Refresh to retry the gateway snapshot.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ResourceStrip({ snapshot }: { snapshot: ActivitySnapshot }) {
  const memoryPercent = percent(snapshot.resources.memory.usedBytes, snapshot.resources.memory.totalBytes);
  const disk = snapshot.resources.disk[0];
  const cpuPressure = Math.min(100, Math.round((snapshot.resources.cpu.load1 / Math.max(1, snapshot.resources.cpu.cores)) * 100));
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric icon={<Cpu className="size-4" />} label="CPU" value={`${cpuPressure}%`} detail={`${snapshot.resources.cpu.cores} cores / load ${snapshot.resources.cpu.load1.toFixed(2)}`} tone="blue" percent={cpuPressure} />
      <Metric icon={<MemoryStick className="size-4" />} label="Memory" value={`${memoryPercent}%`} detail={`${formatBytes(snapshot.resources.memory.availableBytes)} available`} tone="emerald" percent={memoryPercent} />
      <Metric icon={<HardDrive className="size-4" />} label="Disk" value={disk ? `${disk.usedPercent}%` : "-"} detail={disk ? `${formatBytes(disk.usedBytes)} of ${formatBytes(disk.totalBytes)}` : "Unavailable"} tone="amber" percent={disk?.usedPercent ?? 0} />
      <Metric icon={<Zap className="size-4" />} label="Processes" value={String(snapshot.processes.length)} detail={`${formatBytes(snapshot.resources.memory.processRssBytes)} RSS total`} tone="violet" percent={Math.min(100, snapshot.processes.length * 4)} />
    </section>
  );
}

function Metric(props: { icon: ReactNode; label: string; value: string; detail: string; tone: "blue" | "emerald" | "amber" | "violet"; percent: number }) {
  const tone = {
    blue: "bg-sky-500",
    emerald: "bg-emerald-500",
    amber: "bg-amber-500",
    violet: "bg-violet-500",
  }[props.tone];
  return (
    <div className="grid min-h-[116px] gap-3 rounded-md border border-black/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-[#11151d]">
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex items-center gap-2 text-sm font-medium text-[#4c5566] dark:text-[#a7b0c1]">
          {props.icon}
          <span>{props.label}</span>
        </div>
        <span className="text-2xl font-semibold tabular-nums">{props.value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, Math.min(100, props.percent))}%` }} />
      </div>
      <p className="truncate text-xs text-[#687082] dark:text-[#98a1b2]">{props.detail}</p>
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-md border border-black/10 bg-white shadow-sm dark:border-white/10 dark:bg-[#11151d]">
      <div className="flex h-11 items-center gap-2 border-b border-black/10 px-4 text-sm font-semibold dark:border-white/10">
        {icon}
        <span>{title}</span>
      </div>
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  );
}

function ServiceGrid({ services }: { services: ActivitySnapshot["services"] }) {
  if (services.length === 0) return <EmptyLine label="No service data" />;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {services.map((service) => (
        <div key={service.serviceId} className="grid min-h-[76px] gap-2 rounded-md bg-[#f3f5f8] p-3 dark:bg-white/5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{service.serviceId}</span>
            <StateDot state={service.state} />
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs text-[#687082] dark:text-[#98a1b2]">
            <span className="truncate">{service.memoryBytes ? formatBytes(service.memoryBytes) : "-"}</span>
            <span className="truncate">{service.tasks ?? "-"} tasks</span>
            <span className="truncate">{service.cpuSeconds ?? "-"}s CPU</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProcessTable({ processes }: { processes: ActivitySnapshot["processes"] }) {
  if (processes.length === 0) return <EmptyLine label="No process rows" />;
  return (
    <div className="overflow-hidden rounded-md border border-black/10 dark:border-white/10">
      <div className="grid grid-cols-[minmax(140px,1fr)_72px_86px_74px] bg-[#eef1f5] px-3 py-2 text-xs font-semibold text-[#566070] dark:bg-white/10 dark:text-[#a7b0c1]">
        <span>Process</span>
        <span className="text-right">CPU</span>
        <span className="text-right">Memory</span>
        <span className="text-right">Age</span>
      </div>
      {processes.slice(0, 12).map((process) => (
        <div key={process.processRef} className="grid min-h-10 grid-cols-[minmax(140px,1fr)_72px_86px_74px] items-center border-t border-black/10 px-3 py-2 text-sm dark:border-white/10">
          <div className="min-w-0">
            <p className="truncate font-medium">{process.displayName}</p>
            <p className="truncate text-xs text-[#687082] dark:text-[#98a1b2]">{process.ownerClass} / {process.classification}</p>
          </div>
          <span className="text-right tabular-nums">{process.cpuPercent.toFixed(1)}%</span>
          <span className="text-right tabular-nums">{formatBytes(process.rssBytes)}</span>
          <span className="text-right tabular-nums">{formatDuration(process.elapsedSeconds)}</span>
        </div>
      ))}
    </div>
  );
}

function SignalList({ snapshot }: { snapshot: ActivitySnapshot }) {
  const items = [
    ["Release", snapshot.machine.releaseVersion ?? "Unknown"],
    ["Channel", snapshot.machine.releaseChannel ?? "Unknown"],
    ["Commit", snapshot.machine.gitCommit ?? "Unknown"],
    ["Uptime", formatDuration(snapshot.machine.uptimeSeconds)],
    ["Warnings", String(snapshot.collectionWarnings.length)],
  ];
  return (
    <dl className="grid gap-2">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-4 rounded-md bg-[#f3f5f8] px-3 py-2 text-sm dark:bg-white/5">
          <dt className="text-[#687082] dark:text-[#98a1b2]">{label}</dt>
          <dd className="truncate text-right font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function StatusPill({ status }: { status: string }) {
  const healthy = status === "healthy";
  return (
    <span className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium ${
      healthy
        ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-950/40 dark:text-emerald-100"
        : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-100"
    }`}>
      <span className={`size-2 rounded-full ${healthy ? "bg-emerald-500" : "bg-amber-500"}`} />
      {status}
    </span>
  );
}

function StateDot({ state }: { state: string }) {
  const running = state === "running";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${
      running
        ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-100"
        : "bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-100"
    }`}>
      <span className={`size-1.5 rounded-full ${running ? "bg-emerald-500" : "bg-amber-500"}`} />
      {state}
    </span>
  );
}

function ActivitySkeleton() {
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <div key={item} className="h-[116px] animate-pulse rounded-md bg-black/10 dark:bg-white/10" />)}
      </div>
      <div className="h-[360px] animate-pulse rounded-md bg-black/10 dark:bg-white/10" />
    </div>
  );
}

function EmptyLine({ label }: { label: string }) {
  return <p className="rounded-md bg-[#f3f5f8] px-3 py-2 text-sm text-[#687082] dark:bg-white/5 dark:text-[#98a1b2]">{label}</p>;
}

function machineSubtitle(snapshot: ActivitySnapshot | null): string {
  if (!snapshot) return "Waiting for gateway snapshot";
  return `${snapshot.machine.handle ?? "local"} / ${snapshot.machine.runtimeSlot} / ${snapshot.machine.releaseVersion ?? "unknown release"}`;
}

function percent(used: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds: number): string {
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds)}s`;
}
