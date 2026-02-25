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
