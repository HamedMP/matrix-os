import { describe, it, expect, beforeEach } from 'vitest';
import {
  metricsRegistry,
  containersTotal,
  containerCpuUsage,
  containerMemoryUsage,
  containerMemoryLimit,
  provisionDuration,
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
});
