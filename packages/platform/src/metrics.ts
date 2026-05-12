import { Registry, Gauge, Histogram } from 'prom-client';

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
