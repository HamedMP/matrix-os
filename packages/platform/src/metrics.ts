import { Registry, Counter, Gauge, Histogram } from 'prom-client';

export const metricsRegistry = new Registry();

export const containersTotal = new Gauge({
  name: 'platform_containers_total',
  help: 'Total containers by status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export const containerCpuUsage = new Gauge({
  name: 'platform_container_cpu_percent',
  help: 'Container CPU usage percentage',
  labelNames: ['handle'] as const,
  registers: [metricsRegistry],
});

export const containerMemoryUsage = new Gauge({
  name: 'platform_container_memory_bytes',
  help: 'Container memory usage in bytes',
  labelNames: ['handle'] as const,
  registers: [metricsRegistry],
});

export const containerMemoryLimit = new Gauge({
  name: 'platform_container_memory_limit_bytes',
  help: 'Container memory limit in bytes',
  labelNames: ['handle'] as const,
  registers: [metricsRegistry],
});

export const provisionDuration = new Histogram({
  name: 'platform_provision_duration_seconds',
  help: 'Container provisioning duration',
  buckets: [1, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

export const platformHttpRequestsTotal = new Counter({
  name: 'platform_http_requests_total',
  help: 'Total platform HTTP requests by method, path, and status',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [metricsRegistry],
});

export const platformHttpRequestDuration = new Histogram({
  name: 'platform_http_request_duration_seconds',
  help: 'Platform HTTP request duration',
  labelNames: ['method'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [metricsRegistry],
});

export function recordPlatformHttpRequest(input: {
  method: string;
  path: string;
  status: number;
  durationSeconds: number;
}): void {
  const labels = {
    method: input.method,
    path: normalizePlatformMetricPath(input.path),
    status: String(input.status),
  };
  platformHttpRequestsTotal.inc(labels);
  platformHttpRequestDuration.observe(
    { method: labels.method },
    input.durationSeconds,
  );
}

export function normalizePlatformMetricPath(path: string): string {
  if (path === '/') return '/';
  if (path === '/health') return '/health';
  if (path === '/metrics') return '/metrics';
  if (path === '/containers') return '/containers';
  if (path === '/vps') return '/vps';
  if (path === '/runtime') return '/runtime';
  if (path === '/onboarding/computer') return '/onboarding/computer';
  if (path.startsWith('/system-bundles/releases/')) return '/system-bundles/releases/:version';
  if (path.startsWith('/system-bundles/channels/')) return '/system-bundles/channels/:channel';
  if (/^\/system-bundles\/[^/]+\/[^/]+$/.test(path)) {
    return '/system-bundles/:version/:file';
  }
  if (/^\/vps\/[0-9a-f-]+\/status$/.test(path)) return '/vps/:machineId/status';
  if (/^\/vps\/[0-9a-f-]+$/.test(path)) return '/vps/:machineId';
  if (/^\/containers\/[^/]+\/self-upgrade$/.test(path)) return '/containers/:handle/self-upgrade';
  if (/^\/containers\/[^/]+\/upgrade$/.test(path)) return '/containers/:handle/upgrade';
  if (/^\/containers\/[^/]+\/start$/.test(path)) return '/containers/:handle/start';
  if (/^\/containers\/[^/]+\/stop$/.test(path)) return '/containers/:handle/stop';
  if (/^\/containers\/check-handle\/[^/]+$/.test(path)) return '/containers/check-handle/:handle';
  if (/^\/containers\/[^/]+$/.test(path)) return '/containers/:handle';
  if (path.startsWith('/internal/containers/')) return '/internal/containers/:handle/:path';
  if (/^\/social\/profiles\/[^/]+\/ai$/.test(path)) return '/social/profiles/:handle/ai';
  if (/^\/social\/profiles\/[^/]+$/.test(path)) return '/social/profiles/:handle';
  if (/^\/social\/send\/[^/]+$/.test(path)) return '/social/send/:handle';
  if (path.startsWith('/api/')) return '/api/:path';
  return '/:path';
}

export const vpsInfo = new Gauge({
  name: 'matrix_vps_info',
  help: 'VPS instance info (value is always 1, labels carry metadata)',
  labelNames: ['handle', 'machine_id', 'version', 'status'] as const,
  registers: [metricsRegistry],
});

export const vpsHealthy = new Gauge({
  name: 'matrix_vps_healthy',
  help: 'VPS instance health (1=healthy, 0=unhealthy)',
  labelNames: ['handle'] as const,
  registers: [metricsRegistry],
});

export const vpsProvisionFailuresTotal = new Counter({
  name: 'matrix_vps_provision_failures_total',
  help: 'Total customer VPS provision failures by failure code',
  labelNames: ['failure_code'] as const,
  registers: [metricsRegistry],
});

export const vpsRuntimeInfo = new Gauge({
  name: 'matrix_vps_runtime_info',
  help: 'Runtime release info reported by a reachable customer VPS (value is always 1, labels carry metadata)',
  labelNames: ['handle', 'version'] as const,
  registers: [metricsRegistry],
});

export const vpsProbeLatencySeconds = new Gauge({
  name: 'matrix_vps_probe_latency_seconds',
  help: 'Latest VPS system probe latency in seconds',
  labelNames: ['handle'] as const,
  registers: [metricsRegistry],
});

export const vpsLoad1 = new Gauge({
  name: 'matrix_vps_load1',
  help: 'Latest VPS 1-minute load average',
  labelNames: ['handle'] as const,
  registers: [metricsRegistry],
});

export const vpsCpuCount = new Gauge({
  name: 'matrix_vps_cpu_count',
  help: 'VPS CPU count reported by the gateway',
  labelNames: ['handle'] as const,
  registers: [metricsRegistry],
});

export const vpsMemoryTotalBytes = new Gauge({
  name: 'matrix_vps_memory_total_bytes',
  help: 'VPS total memory in bytes',
  labelNames: ['handle'] as const,
  registers: [metricsRegistry],
});

export const vpsMemoryFreeBytes = new Gauge({
  name: 'matrix_vps_memory_free_bytes',
  help: 'VPS free memory in bytes',
  labelNames: ['handle'] as const,
  registers: [metricsRegistry],
});

export const vpsDiskTotalBytes = new Gauge({
  name: 'matrix_vps_disk_total_bytes',
  help: 'VPS root disk size in bytes',
  labelNames: ['handle'] as const,
  registers: [metricsRegistry],
});

export const vpsDiskFreeBytes = new Gauge({
  name: 'matrix_vps_disk_free_bytes',
  help: 'VPS root disk free bytes',
  labelNames: ['handle'] as const,
  registers: [metricsRegistry],
});

export const platformUsersTotal = new Gauge({
  name: 'matrix_platform_users_total',
  help: 'Platform user counts by runtime kind',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});

export const userVpsLink = new Gauge({
  name: 'matrix_user_vps_link',
  help: 'User to VPS mapping (value is always 1, labels carry metadata)',
  labelNames: ['handle', 'status', 'version'] as const,
  registers: [metricsRegistry],
});

export const releaseChannelInfo = new Gauge({
  name: 'matrix_release_channel_info',
  help: 'Release channel pointer info (value is always 1, labels carry metadata)',
  labelNames: ['channel', 'version', 'git_ref', 'git_commit', 'severity'] as const,
  registers: [metricsRegistry],
});

export const releaseChannelCreatedTimestamp = new Gauge({
  name: 'matrix_release_channel_created_timestamp_seconds',
  help: 'Release channel target creation time as Unix seconds',
  labelNames: ['channel', 'version'] as const,
  registers: [metricsRegistry],
});

export const releaseChannelBundleBytes = new Gauge({
  name: 'matrix_release_channel_bundle_bytes',
  help: 'Release channel target bundle size in bytes',
  labelNames: ['channel', 'version'] as const,
  registers: [metricsRegistry],
});

export function refreshVpsMetrics(
  machines: Array<{
    machineId: string;
    handle: string;
    imageVersion: string | null;
    status: string;
  }>,
): void {
  vpsInfo.reset();
  for (const machine of machines) {
    vpsInfo.set(
      {
        handle: machine.handle,
        machine_id: machine.machineId,
        version: machine.imageVersion ?? 'unknown',
        status: machine.status,
      },
      1,
    );
  }
}

export function refreshPlatformUserMetrics(input: {
  machines: Array<{
    handle: string;
    clerkUserId: string;
    machineId: string;
    status: string;
    imageVersion: string | null;
    deletedAt?: string | null;
  }>;
  containers: Array<{
    handle: string;
    clerkUserId: string;
    status: string;
  }>;
}): void {
  platformUsersTotal.reset();
  userVpsLink.reset();

  const allUsers = new Set<string>();
  const vpsUsers = new Set<string>();
  const runningVpsUsers = new Set<string>();
  const legacyContainerUsers = new Set<string>();

  for (const machine of input.machines) {
    allUsers.add(machine.clerkUserId);
    if (!machine.deletedAt && machine.status !== 'deleted') {
      vpsUsers.add(machine.clerkUserId);
      if (machine.status === 'running') runningVpsUsers.add(machine.clerkUserId);
      userVpsLink.set(
        {
          handle: machine.handle,
          status: machine.status,
          version: machine.imageVersion ?? 'unknown',
        },
        1,
      );
    }
  }

  for (const container of input.containers) {
    allUsers.add(container.clerkUserId);
    if (container.status !== 'deleted') legacyContainerUsers.add(container.clerkUserId);
  }

  platformUsersTotal.set({ kind: 'total' }, allUsers.size);
  platformUsersTotal.set({ kind: 'vps' }, vpsUsers.size);
  platformUsersTotal.set({ kind: 'vps_running' }, runningVpsUsers.size);
  platformUsersTotal.set({ kind: 'legacy_container' }, legacyContainerUsers.size);
}

export function refreshReleaseChannelMetrics(
  releases: Array<{
    channel: string;
    version: string;
    gitCommit: string;
    gitRef: string | null;
    severity: string;
    size: number;
    createdAt: string;
  }>,
): void {
  releaseChannelInfo.reset();
  releaseChannelCreatedTimestamp.reset();
  releaseChannelBundleBytes.reset();

  for (const release of releases) {
    const labels = {
      channel: release.channel,
      version: release.version,
      git_ref: release.gitRef ?? 'unknown',
      git_commit: release.gitCommit,
      severity: release.severity,
    };
    releaseChannelInfo.set(labels, 1);
    releaseChannelCreatedTimestamp.set(
      { channel: release.channel, version: release.version },
      Math.floor(new Date(release.createdAt).getTime() / 1000),
    );
    releaseChannelBundleBytes.set(
      { channel: release.channel, version: release.version },
      release.size,
    );
  }
}

export interface VpsRuntimeMetricInput {
  handle: string;
  healthy?: boolean;
  runtimeVersion?: string | null;
  probeLatencyMs?: number | null;
  load1?: number | null;
  cpuCount?: number | null;
  memoryTotalBytes?: number | null;
  memoryFreeBytes?: number | null;
  diskTotalBytes?: number | null;
  diskFreeBytes?: number | null;
}

export function refreshVpsRuntimeMetrics(machines: VpsRuntimeMetricInput[]): void {
  vpsHealthy.reset();
  vpsRuntimeInfo.reset();
  vpsProbeLatencySeconds.reset();
  vpsLoad1.reset();
  vpsCpuCount.reset();
  vpsMemoryTotalBytes.reset();
  vpsMemoryFreeBytes.reset();
  vpsDiskTotalBytes.reset();
  vpsDiskFreeBytes.reset();

  for (const machine of machines) {
    vpsHealthy.set({ handle: machine.handle }, machine.healthy ? 1 : 0);
    if (machine.healthy && machine.runtimeVersion) {
      vpsRuntimeInfo.set({ handle: machine.handle, version: machine.runtimeVersion }, 1);
    }
    if (typeof machine.probeLatencyMs === 'number') {
      vpsProbeLatencySeconds.set({ handle: machine.handle }, machine.probeLatencyMs / 1000);
    }
    if (typeof machine.load1 === 'number') {
      vpsLoad1.set({ handle: machine.handle }, machine.load1);
    }
    if (typeof machine.cpuCount === 'number') {
      vpsCpuCount.set({ handle: machine.handle }, machine.cpuCount);
    }
    if (typeof machine.memoryTotalBytes === 'number') {
      vpsMemoryTotalBytes.set({ handle: machine.handle }, machine.memoryTotalBytes);
    }
    if (typeof machine.memoryFreeBytes === 'number') {
      vpsMemoryFreeBytes.set({ handle: machine.handle }, machine.memoryFreeBytes);
    }
    if (typeof machine.diskTotalBytes === 'number') {
      vpsDiskTotalBytes.set({ handle: machine.handle }, machine.diskTotalBytes);
    }
    if (typeof machine.diskFreeBytes === 'number') {
      vpsDiskFreeBytes.set({ handle: machine.handle }, machine.diskFreeBytes);
    }
  }
}
