import { describe, it, expect, beforeEach } from 'vitest';
import {
  metricsRegistry,
  containersTotal,
  containerCpuUsage,
  containerMemoryUsage,
  containerMemoryLimit,
  provisionDuration,
  normalizePlatformMetricPath,
  recordPlatformHttpRequest,
  refreshPlatformUserMetrics,
  refreshReleaseChannelMetrics,
  refreshVpsMetrics,
  refreshVpsRuntimeMetrics,
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

  it('records normalized platform HTTP request latency', async () => {
    recordPlatformHttpRequest({
      method: 'GET',
      path: '/system-bundles/releases/v2026.05.24-74.json',
      status: 200,
      durationSeconds: 0.12,
    });

    const output = await metricsRegistry.metrics();
    expect(output).toContain('platform_http_requests_total{method="GET",path="/system-bundles/releases/:version",status="200"} 1');
    expect(output).toContain('platform_http_request_duration_seconds_bucket{le="0.25",method="GET"} 1');
    expect(output).not.toContain('platform_http_request_duration_seconds_bucket{le="0.25",method="GET",path=');
  });

  it.each([
    ['/containers/alice/start', '/containers/:handle/start'],
    ['/containers/alice/stop', '/containers/:handle/stop'],
    ['/containers/alice', '/containers/:handle'],
    ['/containers/check-handle/alice', '/containers/check-handle/:handle'],
    ['/system-bundles/v2026.05.24-1/custom-bundle.tar.gz', '/system-bundles/:version/:file'],
    ['/social/profiles/alice', '/social/profiles/:handle'],
    ['/social/profiles/alice/ai', '/social/profiles/:handle/ai'],
    ['/social/send/alice', '/social/send/:handle'],
  ])('normalizes handle-bearing platform metric path %s', (path, expected) => {
    expect(normalizePlatformMetricPath(path)).toBe(expected);
  });

  it('collapses unknown request paths to avoid unbounded metric cardinality', () => {
    expect(normalizePlatformMetricPath('/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe('/:path');
    expect(normalizePlatformMetricPath('/random/user/supplied/path')).toBe('/:path');
    expect(normalizePlatformMetricPath('/')).toBe('/');
  });

  it.each(['/health', '/metrics', '/containers', '/vps', '/runtime', '/onboarding/computer'])(
    'keeps exact platform metric path %s distinct',
    (path) => {
      expect(normalizePlatformMetricPath(path)).toBe(path);
    },
  );

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

  it('refreshes VPS runtime gauges for Grafana scraping', async () => {
    refreshVpsRuntimeMetrics([
      {
        handle: 'alice',
        healthy: true,
        runtimeVersion: 'v2026.05.27-133',
        probeLatencyMs: 125,
        load1: 0.42,
        cpuCount: 2,
        memoryTotalBytes: 4 * 1024 * 1024 * 1024,
        memoryFreeBytes: 1024 * 1024 * 1024,
        diskTotalBytes: 40 * 1024 * 1024 * 1024,
        diskFreeBytes: 30 * 1024 * 1024 * 1024,
      },
    ]);

    const output = await metricsRegistry.metrics();
    expect(output).toContain('matrix_vps_healthy{handle="alice"} 1');
    expect(output).toContain('matrix_vps_runtime_info{handle="alice",version="v2026.05.27-133"} 1');
    expect(output).toContain('matrix_vps_probe_latency_seconds{handle="alice"} 0.125');
    expect(output).toContain('matrix_vps_load1{handle="alice"} 0.42');
    expect(output).toContain('matrix_vps_cpu_count{handle="alice"} 2');
    expect(output).toContain('matrix_vps_memory_total_bytes{handle="alice"} 4294967296');
    expect(output).toContain('matrix_vps_memory_free_bytes{handle="alice"} 1073741824');
    expect(output).toContain('matrix_vps_disk_total_bytes{handle="alice"} 42949672960');
    expect(output).toContain('matrix_vps_disk_free_bytes{handle="alice"} 32212254720');
  });

  it('suppresses runtime release info for unhealthy or unversioned VPS probes', async () => {
    refreshVpsRuntimeMetrics([
      { handle: 'alice', healthy: false, runtimeVersion: 'v2026.05.27-133' },
      { handle: 'bob', healthy: true, runtimeVersion: null },
    ]);

    const output = await metricsRegistry.metrics();
    expect(output).toContain('matrix_vps_healthy{handle="alice"} 0');
    expect(output).toContain('matrix_vps_healthy{handle="bob"} 1');
    expect(output).not.toContain('matrix_vps_runtime_info{handle="alice"');
    expect(output).not.toContain('matrix_vps_runtime_info{handle="bob"');
  });

  it('refreshes platform user and user-to-VPS link metrics', async () => {
    refreshPlatformUserMetrics({
      machines: [
        {
          handle: 'alice',
          clerkUserId: 'user_alice',
          machineId: 'machine-1',
          status: 'running',
          imageVersion: 'v2026.05.24-1',
        },
      ],
      containers: [
        {
          handle: 'bob',
          clerkUserId: 'user_bob',
          status: 'running',
        },
      ],
    });

    const output = await metricsRegistry.metrics();
    expect(output).toContain('matrix_platform_users_total{kind="total"} 2');
    expect(output).toContain('matrix_platform_users_total{kind="vps"} 1');
    expect(output).toContain('matrix_platform_users_total{kind="vps_running"} 1');
    expect(output).toContain('matrix_platform_users_total{kind="legacy_container"} 1');
    expect(output).toContain('matrix_user_vps_link{handle="alice",status="running",version="v2026.05.24-1"} 1');
    expect(output).not.toContain('clerk_user_id=');
  });

  it('refreshes release channel metrics', async () => {
    refreshReleaseChannelMetrics([
      {
        channel: 'stable',
        version: 'v2026.05.24-1',
        gitCommit: 'abc123',
        gitRef: 'main',
        severity: 'normal',
        size: 1234,
        createdAt: '2026-05-24T10:00:00.000Z',
      },
    ]);

    const output = await metricsRegistry.metrics();
    expect(output).toContain('matrix_release_channel_info{channel="stable",version="v2026.05.24-1",git_ref="main",git_commit="abc123",severity="normal"} 1');
    expect(output).toContain('matrix_release_channel_created_timestamp_seconds{channel="stable",version="v2026.05.24-1"} 1779616800');
    expect(output).toContain('matrix_release_channel_bundle_bytes{channel="stable",version="v2026.05.24-1"} 1234');
  });
});
