import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { promisify } from "node:util";
import { cpus, freemem, hostname, loadavg, totalmem, uptime } from "node:os";
import type { ActivityCollectOptions, ActivitySnapshot, MachineIdentity, ProcessSummary, ServiceStatus } from "./types.js";
import { getSystemInfo } from "../system-info.js";
import type { CleanupCandidateRegistry } from "./cleanup.js";

const execFileAsync = promisify(execFile);
const PROCESS_TIMEOUT_MS = 2_000;
const SERVICES = ["matrix-gateway", "matrix-shell", "matrix-code", "matrix-sync-agent"] as const;

export async function collectSystemActivity(options: {
  homePath: string;
  collectOptions: ActivityCollectOptions;
  candidates: CleanupCandidateRegistry;
  cleanupGracePeriodSeconds?: number;
}): Promise<ActivitySnapshot> {
  const warnings: string[] = [];
  const systemInfo = getSystemInfo(options.homePath);
  const [load1 = 0, load5 = 0, load15 = 0] = loadavg();
  const processes = await collectProcesses(options.collectOptions.processLimit, warnings);
  const [rootDisk, homeDisk, pressureSome10, cgroupMemory, services] = await Promise.all([
    readDisk("/", "System", warnings),
    readDisk(options.homePath, "Home", warnings),
    readCpuPressure(warnings),
    readCgroupMemory(warnings),
    collectServices(warnings),
  ]);
  const processRssBytes = processes.reduce((sum, process) => sum + process.rssBytes, 0);
  const totalMemory = totalmem();
  const availableMemory = freemem();
  const cpuCores = cpus().length;

  return {
    generatedAt: new Date().toISOString(),
    machine: {
      handle: systemInfo.runtime.handle,
      runtimeSlot: systemInfo.runtime.runtimeSlot,
      hostname: sanitizeDisplay(hostname()),
      status: deriveMachineStatus({ load1, pressureSome10, services, cpuCores }),
      releaseVersion: systemInfo.release?.version ?? systemInfo.installedVersion,
      releaseChannel: systemInfo.release?.channel,
      gitCommit: systemInfo.release?.gitCommit?.slice(0, 12) ?? systemInfo.build.sha,
      uptimeSeconds: Math.floor(uptime()),
    },
    resources: {
      cpu: {
        cores: cpuCores,
        load1,
        load5,
        load15,
        pressureSome10,
      },
      memory: {
        totalBytes: totalMemory,
        usedBytes: Math.max(0, totalMemory - availableMemory),
        availableBytes: availableMemory,
        processRssBytes,
        ...cgroupMemory,
      },
      swap: await readSwap(warnings),
      disk: [rootDisk, homeDisk].filter((disk): disk is NonNullable<typeof disk> => Boolean(disk)),
    },
    services,
    processes,
    cleanupSuggestions: options.collectOptions.includeSuggestions
      ? options.candidates.classify(processes, Date.now(), { minElapsedSeconds: options.cleanupGracePeriodSeconds })
      : [],
    collectionWarnings: warnings.slice(0, 8),
  };
}

async function collectProcesses(limit: number, warnings: string[]): Promise<ProcessSummary[]> {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-eo", "pid=,ppid=,user=,stat=,pcpu=,rss=,etimes=,comm=,args=", "--sort=-rss"],
      { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 512_000 },
    );
    const activeConnections = await collectActiveConnectionCounts(warnings);
    return stdout
      .split("\n")
      .map((line) => parseProcessLine(line))
      .filter((process): process is ProcessSummary => Boolean(process))
      .map((process) => attachActiveConnections(process, activeConnections))
      .slice(0, limit);
  } catch (err) {
    pushWarning(warnings, "process_collection_unavailable", err);
    return [];
  }
}

function parseProcessLine(line: string): ProcessSummary | null {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
  if (!match) return null;
  const [, pidRaw, , user, , cpuRaw, rssRaw, elapsedRaw, comm, args = ""] = match;
  const pid = Number(pidRaw);
  const displayName = displayNameFor(comm ?? "", args);
  return {
    processRef: `proc_${pid}`,
    pid,
    ownerClass: ownerClassFor(user ?? ""),
    classification: classifyProcess(comm ?? "", args),
    displayName,
    cpuPercent: Number(cpuRaw) || 0,
    rssBytes: (Number(rssRaw) || 0) * 1024,
    elapsedSeconds: Number(elapsedRaw) || 0,
    ports: [],
    activeConnections: undefined,
  };
}

async function collectActiveConnectionCounts(warnings: string[]): Promise<Map<number, number> | null> {
  try {
    const { stdout } = await execFileAsync(
      "ss",
      ["-H", "-tanp", "state", "established"],
      { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 512_000 },
    );
    return parseSocketConnectionCounts(stdout);
  } catch (err) {
    pushWarning(warnings, "connection_collection_unavailable", err);
    return null;
  }
}

function attachActiveConnections(process: ProcessSummary, connections: Map<number, number> | null): ProcessSummary {
  if (process.classification !== "app_server" || process.pid === undefined || !connections) return process;
  return { ...process, activeConnections: connections.get(process.pid) ?? 0 };
}

export function parseSocketConnectionCounts(output: string): Map<number, number> {
  const counts = new Map<number, number>();
  for (const line of output.split("\n")) {
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(match[1]);
      if (Number.isInteger(pid) && pid > 0) counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
  }
  return counts;
}

async function collectServices(warnings: string[]): Promise<ServiceStatus[]> {
  const results = await Promise.all(SERVICES.map((serviceId) => readService(serviceId, warnings)));
  return results;
}

async function readService(serviceId: string, warnings: string[]): Promise<ServiceStatus> {
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["show", `${serviceId}.service`, "--property=ActiveState,SubState,MemoryCurrent,CPUUsageNSec,TasksCurrent,NRestarts", "--no-pager"],
      { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 32_000 },
    );
    const properties = Object.fromEntries(stdout.trim().split("\n").map((line) => {
      const [key, ...rest] = line.split("=");
      return [key, rest.join("=")];
    }));
    return {
      serviceId,
      state: serviceState(properties.ActiveState, properties.SubState),
      memoryBytes: numberProperty(properties.MemoryCurrent),
      cpuSeconds: properties.CPUUsageNSec ? Math.round(Number(properties.CPUUsageNSec) / 1_000_000_000) : undefined,
      tasks: numberProperty(properties.TasksCurrent),
      restartCount: numberProperty(properties.NRestarts),
    };
  } catch (err) {
    pushWarning(warnings, "service_collection_partial", err);
    return { serviceId, state: "unknown" };
  }
}

async function readDisk(path: string, label: string, warnings: string[]) {
  try {
    const stats = await statfs(path);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      mount: label === "System" ? "/" : "home",
      label,
      usedBytes,
      totalBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
    };
  } catch (err) {
    pushWarning(warnings, "disk_collection_partial", err);
    return null;
  }
}

async function readCpuPressure(warnings: string[]): Promise<number | undefined> {
  try {
    const content = await readFile("/proc/pressure/cpu", "utf8");
    const some = content.split("\n").find((line) => line.startsWith("some "));
    const avg10 = some?.match(/avg10=([\d.]+)/)?.[1];
    return avg10 ? Number(avg10) : undefined;
  } catch (err) {
    pushWarning(warnings, "pressure_collection_unavailable", err);
    return undefined;
  }
}

async function readCgroupMemory(warnings: string[]) {
  try {
    const content = await readFile("/sys/fs/cgroup/memory.stat", "utf8");
    const values = Object.fromEntries(content.split("\n").map((line) => {
      const [key, value] = line.trim().split(/\s+/);
      return [key, Number(value) || 0];
    }));
    return {
      cgroupAnonBytes: values.anon ?? 0,
      cgroupFileBytes: values.file ?? 0,
      cgroupKernelBytes: values.kernel ?? 0,
    };
  } catch (err) {
    pushWarning(warnings, "cgroup_memory_unavailable", err);
    return {};
  }
}

async function readSwap(warnings: string[]): Promise<{ totalBytes: number; usedBytes: number }> {
  try {
    const content = await readFile("/proc/meminfo", "utf8");
    const values = Object.fromEntries(content.split("\n").map((line) => {
      const [key, value] = line.split(":");
      return [key, Number(value?.trim().split(/\s+/)[0]) * 1024 || 0];
    }));
    const total = values.SwapTotal ?? 0;
    const free = values.SwapFree ?? 0;
    return { totalBytes: total, usedBytes: Math.max(0, total - free) };
  } catch (err) {
    pushWarning(warnings, "swap_collection_unavailable", err);
    return { totalBytes: 0, usedBytes: 0 };
  }
}

export function classifyProcess(comm: string, args: string): ProcessSummary["classification"] {
  const text = `${comm} ${args}`.toLowerCase();
  if (text.includes("matrix-gateway") || text.includes("matrix-shell") || text.includes("sync-agent")) return "matrix_service";
  if (text.includes("next-server") || isViteCommand(comm, args)) return "app_server";
  if (text.includes("zellij")) return "terminal_session";
  if (text.includes("code-server")) return "code_editor";
  if (text.includes("postgres")) return "database";
  if (comm.startsWith("systemd")) return "system";
  return "unknown";
}

function ownerClassFor(user: string): ProcessSummary["ownerClass"] {
  if (user === "matrix") return "matrix";
  if (user === "root") return "root";
  if (user.startsWith("_") || user === "systemd+") return "system";
  return "unknown";
}

function displayNameFor(comm: string, args: string): string {
  const text = `${comm} ${args}`;
  if (text.includes("matrix-gateway")) return "matrix-gateway";
  if (text.includes("matrix-shell")) return "matrix-shell";
  if (text.includes("matrix-sync-agent")) return "matrix-sync-agent";
  if (text.includes("code-server")) return "code-server";
  if (text.includes("next-server")) return "Next.js app server";
  if (isViteCommand(comm, args)) return "Vite app server";
  return sanitizeDisplay(comm || "process");
}

function isViteCommand(comm: string, args: string): boolean {
  return /\bvite\b/.test(`${comm} ${args}`.toLowerCase());
}

export function deriveMachineStatus(input: {
  load1: number;
  pressureSome10?: number;
  services: ServiceStatus[];
  cpuCores: number;
}): MachineIdentity["status"] {
  if (input.services.length > 0 && input.services.every((service) => service.state === "unknown")) return "unknown";
  if (input.services.some((service) => service.state === "failed")) return "degraded";
  if (input.load1 > input.cpuCores * 2) return "degraded";
  if ((input.pressureSome10 ?? 0) >= 20) return "degraded";
  return "healthy";
}

function serviceState(active?: string, sub?: string): ServiceStatus["state"] {
  if (active === "active" && sub === "running") return "running";
  if (active === "activating") return "starting";
  if (active === "failed") return "failed";
  if (active === "inactive") return "stopped";
  return "unknown";
}

function numberProperty(value: string | undefined): number | undefined {
  if (!value || value === "[not set]") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitizeDisplay(value: string): string {
  return value.replace(/[^\w .:@/-]/g, "").slice(0, 80) || "unknown";
}

function pushWarning(warnings: string[], code: string, err: unknown): void {
  if (warnings.length < 8) warnings.push(code);
  console.warn("[system-activity] collector warning:", code, err instanceof Error ? err.message : String(err));
}
