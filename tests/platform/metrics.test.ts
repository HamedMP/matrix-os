import { describe, it, expect, beforeEach } from 'vitest';
import {
  metricsRegistry,
  containersTotal,
  containerCpuUsage,
  containerMemoryUsage,
  containerMemoryLimit,
  provisionDuration,
  refreshVpsMetrics,
} from '../../packages/platform/src/metrics.js';

describe('platform/metrics', () => {
  beforeEach(async () => {
    metricsRegistry.resetMetrics();
  });

  it('exports a Prometheus registry', () => {
    expect(metricsRegistry).toBeDefined();
    expect(typeof metricsRegistry.metrics).toBe('function');
  });

  it('registry returns valid Prometheus text format', async () => {
    const output = await metricsRegistry.metrics();
    expect(typeof output).toBe('string');
    expect(output).toContain('platform_containers_total');
  });

  it('containersTotal gauge tracks running and stopped', async () => {
    containersTotal.set({ status: 'running' }, 5);
    containersTotal.set({ status: 'stopped' }, 3);

    const output = await metricsRegistry.metrics();
    expect(output).toContain('platform_containers_total{status="running"} 5');
    expect(output).toContain('platform_containers_total{status="stopped"} 3');
  });

  it('containerCpuUsage gauge tracks per-handle CPU', async () => {
    containerCpuUsage.set({ handle: 'alice' }, 42.5);

    const output = await metricsRegistry.metrics();
    expect(output).toContain('platform_container_cpu_percent{handle="alice"} 42.5');
  });

  it('containerMemoryUsage and limit gauges track per-handle memory', async () => {
    containerMemoryUsage.set({ handle: 'alice' }, 512 * 1024 * 1024);
    containerMemoryLimit.set({ handle: 'alice' }, 1024 * 1024 * 1024);

    const output = await metricsRegistry.metrics();
    expect(output).toContain('platform_container_memory_bytes{handle="alice"} 536870912');
    expect(output).toContain('platform_container_memory_limit_bytes{handle="alice"} 1073741824');
  });

  it('provisionDuration histogram records timing', async () => {
    provisionDuration.observe(5.2);
    provisionDuration.observe(12.7);

    const output = await metricsRegistry.metrics();
    expect(output).toContain('platform_provision_duration_seconds_bucket');
    expect(output).toContain('platform_provision_duration_seconds_count 2');
  });

  it('refreshes VPS version labels for Grafana scraping', async () => {
    refreshVpsMetrics([
      {
        machineId: 'machine-1',
        handle: 'alice',
        imageVersion: 'v2026.05.12-1',
        status: 'running',
      },
      {
        machineId: 'machine-2',
        handle: 'bob',
        imageVersion: null,
        status: 'provisioning',
      },
    ]);

    const output = await metricsRegistry.metrics();
    expect(output).toContain('matrix_vps_info{handle="alice",machine_id="machine-1",version="v2026.05.12-1",status="running"} 1');
    expect(output).toContain('matrix_vps_info{handle="bob",machine_id="machine-2",version="unknown",status="provisioning"} 1');
  });
});
