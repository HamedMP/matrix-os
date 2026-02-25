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
  containerId: string;
  status: string;
}

export interface StatsCollectorConfig {
  docker: Dockerode;
  listRunning: () => RunningContainer[];
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

export function createStatsCollector(config: StatsCollectorConfig): StatsCollector {
  const { docker, listRunning, intervalMs = 15_000 } = config;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function collectOnce(): Promise<ContainerStats[]> {
    const containers = listRunning();
    const results: ContainerStats[] = [];

    for (const row of containers) {
      if (!row.containerId) continue;

      try {
        const container = docker.getContainer(row.containerId);
        const raw = await container.stats({ stream: false } as any);

        const cpuPercent = parseCpuPercent(raw);
        const memUsage = raw.memory_stats?.usage ?? 0;
        const memLimit = raw.memory_stats?.limit ?? 0;

        const entry: ContainerStats = {
          handle: row.handle,
          cpuPercent,
          memoryUsage: memUsage,
          memoryLimit: memLimit,
          timestamp: Date.now(),
        };

        containerCpuUsage.set({ handle: row.handle }, cpuPercent);
        containerMemoryUsage.set({ handle: row.handle }, memUsage);
        containerMemoryLimit.set({ handle: row.handle }, memLimit);

        results.push(entry);
      } catch {
        // Container disappeared or stats unavailable -- skip
      }
    }

    return results;
  }

  return {
    collectOnce,

    start() {
      if (timer) return;
      timer = setInterval(() => {
        collectOnce().catch(() => {});
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
