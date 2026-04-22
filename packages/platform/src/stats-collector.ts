import type Dockerode from 'dockerode';
import {
  containerCpuUsage,
  containerMemoryUsage,
  containerMemoryLimit,
} from './metrics.js';

export interface ContainerStats {
  handle: string;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  timestamp: number;
}

interface RunningContainer {
  handle: string;
  containerId: string | null;
  status: string;
}

export interface StatsCollectorConfig {
  docker: Dockerode;
  listRunning: () => RunningContainer[];
  onResolvedContainerId?: (handle: string, containerId: string) => void;
  intervalMs?: number;
}

export interface StatsCollector {
  collectOnce(): Promise<ContainerStats[]>;
  start(): void;
  stop(): void;
}

function parseCpuPercent(stats: any): number {
  const cpuDelta =
    stats.cpu_stats.cpu_usage.total_usage -
    stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta =
    stats.cpu_stats.system_cpu_usage -
    stats.precpu_stats.system_cpu_usage;

  if (systemDelta <= 0) return 0;

  const numCpus = stats.cpu_stats.online_cpus ?? 1;
  return (cpuDelta / systemDelta) * numCpus * 100;
}

function buildAndRecordEntry(handle: string, raw: any): ContainerStats {
  const cpuPercent = parseCpuPercent(raw);
  const memoryUsage = raw.memory_stats?.usage ?? 0;
  const memoryLimit = raw.memory_stats?.limit ?? 0;

  containerCpuUsage.set({ handle }, cpuPercent);
  containerMemoryUsage.set({ handle }, memoryUsage);
  containerMemoryLimit.set({ handle }, memoryLimit);

  return {
    handle,
    cpuPercent,
    memoryUsage,
    memoryLimit,
    timestamp: Date.now(),
  };
}

export function createStatsCollector(config: StatsCollectorConfig): StatsCollector {
  const { docker, listRunning, onResolvedContainerId, intervalMs = 15_000 } = config;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function collectOnce(): Promise<ContainerStats[]> {
    const containers = listRunning();
    const results: ContainerStats[] = [];

    for (const row of containers) {
      if (!row.containerId) continue;

      let container = docker.getContainer(row.containerId);
      try {
        const raw = await container.stats({ stream: false } as any) as any;
        results.push(buildAndRecordEntry(row.handle, raw));
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('No such container')) {
          try {
            container = docker.getContainer(`matrixos-${row.handle}`);
            const inspect = await container.inspect();
            onResolvedContainerId?.(row.handle, inspect.Id);
            const raw = await container.stats({ stream: false } as any) as any;
            results.push(buildAndRecordEntry(row.handle, raw));
            continue;
          } catch (_fallbackErr: unknown) {
            // Fall through to the warning below.
          }
        }
        console.warn(
          `[stats-collector] Failed to collect stats for ${row.handle}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return results;
  }

  return {
    collectOnce,

    start() {
      if (timer) return;
      timer = setInterval(() => {
        collectOnce().catch((err: unknown) => {
          console.warn(
            "[stats-collector] Periodic collection failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      }, intervalMs);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
