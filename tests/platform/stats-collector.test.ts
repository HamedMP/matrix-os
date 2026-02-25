import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  metricsRegistry,
  containerCpuUsage,
  containerMemoryUsage,
  containerMemoryLimit,
  containersTotal,
} from '../../packages/platform/src/metrics.js';
import { createStatsCollector, type StatsCollector } from '../../packages/platform/src/stats-collector.js';

function makeDockerStats(opts: {
  cpuDelta?: number;
  systemCpuDelta?: number;
  numCpus?: number;
  memoryUsage?: number;
  memoryLimit?: number;
}) {
  const cpuDelta = opts.cpuDelta ?? 50_000_000;
  const systemCpuDelta = opts.systemCpuDelta ?? 1_000_000_000;
  const numCpus = opts.numCpus ?? 2;
  const preCpu = 100_000_000;
  const preSystem = 5_000_000_000;

  return {
    cpu_stats: {
      cpu_usage: { total_usage: preCpu + cpuDelta },
      system_cpu_usage: preSystem + systemCpuDelta,
      online_cpus: numCpus,
    },
    precpu_stats: {
      cpu_usage: { total_usage: preCpu },
      system_cpu_usage: preSystem,
    },
    memory_stats: {
      usage: opts.memoryUsage ?? 256 * 1024 * 1024,
      limit: opts.memoryLimit ?? 1024 * 1024 * 1024,
    },
  };
}

function createMockDocker(containerStats: Record<string, object>) {
  return {
    getContainer: vi.fn((id: string) => ({
      stats: vi.fn().mockResolvedValue(containerStats[id] ?? {}),
    })),
  };
}

interface ContainerRow {
  handle: string;
  containerId: string;
  status: string;
}

function createMockDb(rows: ContainerRow[]) {
  return {
    _rows: rows,
    listRunningContainers(): ContainerRow[] {
      return this._rows.filter((r) => r.status === 'running');
    },
  };
}

describe('platform/stats-collector', () => {
  beforeEach(async () => {
    metricsRegistry.resetMetrics();
  });

  it('collectOnce returns stats for all running containers', async () => {
    const stats = makeDockerStats({
      cpuDelta: 50_000_000,
      systemCpuDelta: 1_000_000_000,
      numCpus: 2,
      memoryUsage: 256 * 1024 * 1024,
      memoryLimit: 1024 * 1024 * 1024,
    });

    const docker = createMockDocker({ 'container-1': stats });
    const db = createMockDb([
      { handle: 'alice', containerId: 'container-1', status: 'running' },
    ]);

    const collector = createStatsCollector({
      docker: docker as any,
      listRunning: () => db.listRunningContainers(),
    });

    const results = await collector.collectOnce();
    expect(results).toHaveLength(1);
    expect(results[0].handle).toBe('alice');
  });

  it('calculates CPU percentage correctly', async () => {
    // CPU% = (cpuDelta / systemCpuDelta) * numCpus * 100
    // = (50_000_000 / 1_000_000_000) * 4 * 100 = 20%
    const stats = makeDockerStats({
      cpuDelta: 50_000_000,
      systemCpuDelta: 1_000_000_000,
      numCpus: 4,
    });

    const docker = createMockDocker({ 'c1': stats });
    const db = createMockDb([
      { handle: 'alice', containerId: 'c1', status: 'running' },
    ]);

    const collector = createStatsCollector({
      docker: docker as any,
      listRunning: () => db.listRunningContainers(),
    });

    const results = await collector.collectOnce();
    expect(results[0].cpuPercent).toBeCloseTo(20, 1);
  });

  it('extracts memory usage and limit', async () => {
    const stats = makeDockerStats({
      memoryUsage: 512 * 1024 * 1024,
      memoryLimit: 2048 * 1024 * 1024,
    });

    const docker = createMockDocker({ 'c1': stats });
    const db = createMockDb([
      { handle: 'alice', containerId: 'c1', status: 'running' },
    ]);

    const collector = createStatsCollector({
      docker: docker as any,
      listRunning: () => db.listRunningContainers(),
    });

    const results = await collector.collectOnce();
    expect(results[0].memoryUsage).toBe(512 * 1024 * 1024);
    expect(results[0].memoryLimit).toBe(2048 * 1024 * 1024);
  });

  it('handles disappeared container gracefully', async () => {
    const docker = {
      getContainer: vi.fn(() => ({
        stats: vi.fn().mockRejectedValue(new Error('no such container')),
      })),
    };

    const db = createMockDb([
      { handle: 'ghost', containerId: 'gone-1', status: 'running' },
    ]);

    const collector = createStatsCollector({
      docker: docker as any,
      listRunning: () => db.listRunningContainers(),
    });

    const results = await collector.collectOnce();
    expect(results).toHaveLength(0);
  });

  it('skips containers without containerId', async () => {
    const docker = createMockDocker({});
    const db = createMockDb([
      { handle: 'alice', containerId: '', status: 'running' },
    ]);

    const collector = createStatsCollector({
      docker: docker as any,
      listRunning: () => db.listRunningContainers(),
    });

    const results = await collector.collectOnce();
    expect(results).toHaveLength(0);
    expect(docker.getContainer).not.toHaveBeenCalled();
  });

  it('updates Prometheus gauges on collectOnce', async () => {
    const stats = makeDockerStats({
      cpuDelta: 100_000_000,
      systemCpuDelta: 1_000_000_000,
      numCpus: 2,
      memoryUsage: 300 * 1024 * 1024,
      memoryLimit: 1024 * 1024 * 1024,
    });

    const docker = createMockDocker({ 'c1': stats });
    const db = createMockDb([
      { handle: 'alice', containerId: 'c1', status: 'running' },
    ]);

    const collector = createStatsCollector({
      docker: docker as any,
      listRunning: () => db.listRunningContainers(),
    });

    await collector.collectOnce();

    const metricsOutput = await metricsRegistry.metrics();
    expect(metricsOutput).toContain('platform_container_cpu_percent{handle="alice"}');
    expect(metricsOutput).toContain('platform_container_memory_bytes{handle="alice"}');
    expect(metricsOutput).toContain('platform_container_memory_limit_bytes{handle="alice"}');
  });

  it('start/stop manages interval lifecycle', async () => {
    vi.useFakeTimers();

    const stats = makeDockerStats({});
    const docker = createMockDocker({ 'c1': stats });
    const db = createMockDb([
      { handle: 'alice', containerId: 'c1', status: 'running' },
    ]);

    const collector = createStatsCollector({
      docker: docker as any,
      listRunning: () => db.listRunningContainers(),
      intervalMs: 5000,
    });

    collector.start();

    await vi.advanceTimersByTimeAsync(5000);
    expect(docker.getContainer).toHaveBeenCalled();

    const callCount = docker.getContainer.mock.calls.length;
    collector.stop();

    await vi.advanceTimersByTimeAsync(10000);
    expect(docker.getContainer.mock.calls.length).toBe(callCount);

    vi.useRealTimers();
  });

  it('handles multiple containers in a single poll', async () => {
    const stats1 = makeDockerStats({ memoryUsage: 100 * 1024 * 1024 });
    const stats2 = makeDockerStats({ memoryUsage: 200 * 1024 * 1024 });

    const docker = createMockDocker({ 'c1': stats1, 'c2': stats2 });
    const db = createMockDb([
      { handle: 'alice', containerId: 'c1', status: 'running' },
      { handle: 'bob', containerId: 'c2', status: 'running' },
    ]);

    const collector = createStatsCollector({
      docker: docker as any,
      listRunning: () => db.listRunningContainers(),
    });

    const results = await collector.collectOnce();
    expect(results).toHaveLength(2);

    const alice = results.find((r) => r.handle === 'alice')!;
    const bob = results.find((r) => r.handle === 'bob')!;
    expect(alice.memoryUsage).toBe(100 * 1024 * 1024);
    expect(bob.memoryUsage).toBe(200 * 1024 * 1024);
  });
});
