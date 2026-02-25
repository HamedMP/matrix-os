# 034: Container Observability

## Status: Planned

## Problem

Matrix OS runs user containers via dockerode (packages/platform/) but has near-zero runtime visibility. The admin dashboard aggregates health status and system info at a point in time, but there is no historical metrics, no log aggregation, no alerting, and no resource usage tracking. The interaction logger exists but is never wired into the dispatcher. As the platform scales to multi-tenant, operators are flying blind.

Current gaps:
- No CPU/memory/network metrics over time per container
- No centralized log aggregation (JSONL files in each container, no search)
- No alerting when a container is unhealthy, OOM-killed, or cost-spiking
- No `/metrics` endpoint on any service (gateway, platform, proxy)
- Interaction logger (`packages/gateway/src/logger.ts`) created but never called in dispatcher
- `monitor.sh` is a single-shot CLI scrape, not continuous monitoring
- No distributed tracing (acceptable for now, skip)

## Solution

Grafana + Prometheus + Loki observability stack, deployed as containers alongside the platform. Three layers:

1. **Metrics** (Prometheus): `/metrics` endpoints on gateway, platform, and proxy. Container resource metrics via dockerode `stats()` stream. Pre-built Grafana dashboards.
2. **Logs** (Loki + Promtail): Tail JSONL interaction logs, activity.log, and container stdout. Searchable in Grafana.
3. **Alerting** (Grafana Alerting): Rules for container health, cost spikes, error rates, resource exhaustion.

Plus: wire the existing interaction logger into the dispatch loop so it actually records data.

## Task Range: T1200-T1229

## Architecture

```
                    Grafana (:3200)
                   /       \
        Prometheus          Loki
         (:9090)           (:3100)
        /   |   \             |
   gateway  platform  proxy   Promtail
   :4000    :9000     :8080   (log tailer)
   /metrics /metrics  /metrics
        \       |       /
         Container stats
         (dockerode stats stream)
```

All observability services run in the platform compose stack. User containers are NOT modified -- metrics are collected externally via Docker API.

## Design

### Prometheus Metrics (prom-client)

Each service exposes `/metrics` in Prometheus text format using `prom-client`.

#### Gateway Metrics

```typescript
// packages/gateway/src/metrics.ts
import { Registry, Counter, Histogram, Gauge } from "prom-client";

const registry = new Registry();

// Request metrics
const httpRequestsTotal = new Counter({
  name: "gateway_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "path", "status"],
  registers: [registry],
});

const httpRequestDuration = new Histogram({
  name: "gateway_http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "path"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10],
  registers: [registry],
});

// Kernel dispatch metrics
const kernelDispatchTotal = new Counter({
  name: "gateway_kernel_dispatch_total",
  help: "Total kernel dispatches",
  labelNames: ["source", "status"],
  registers: [registry],
});

const kernelDispatchDuration = new Histogram({
  name: "gateway_kernel_dispatch_duration_seconds",
  help: "Kernel dispatch duration",
  labelNames: ["source"],
  buckets: [0.5, 1, 5, 10, 30, 60, 120],
  registers: [registry],
});

// WebSocket connections
const wsConnectionsActive = new Gauge({
  name: "gateway_ws_connections_active",
  help: "Active WebSocket connections",
  registers: [registry],
});

// AI cost tracking
const aiCostTotal = new Counter({
  name: "gateway_ai_cost_usd_total",
  help: "Cumulative AI API cost in USD",
  labelNames: ["model"],
  registers: [registry],
});

const aiTokensTotal = new Counter({
  name: "gateway_ai_tokens_total",
  help: "Total AI tokens used",
  labelNames: ["model", "direction"], // direction: "input" | "output"
  registers: [registry],
});
```

#### Platform Metrics

```typescript
// packages/platform/src/metrics.ts
const containersTotal = new Gauge({
  name: "platform_containers_total",
  help: "Total containers by status",
  labelNames: ["status"], // running, stopped
  registers: [registry],
});

const containerCpuUsage = new Gauge({
  name: "platform_container_cpu_percent",
  help: "Container CPU usage percentage",
  labelNames: ["handle"],
  registers: [registry],
});

const containerMemoryUsage = new Gauge({
  name: "platform_container_memory_bytes",
  help: "Container memory usage in bytes",
  labelNames: ["handle"],
  registers: [registry],
});

const containerMemoryLimit = new Gauge({
  name: "platform_container_memory_limit_bytes",
  help: "Container memory limit in bytes",
  labelNames: ["handle"],
  registers: [registry],
});

const provisionDuration = new Histogram({
  name: "platform_provision_duration_seconds",
  help: "Container provisioning duration",
  buckets: [1, 5, 10, 30, 60],
  registers: [registry],
});
```

#### Proxy Metrics

```typescript
// packages/proxy/src/metrics.ts
const apiCallsTotal = new Counter({
  name: "proxy_api_calls_total",
  help: "Total API calls proxied",
  labelNames: ["user_id", "model", "status"],
  registers: [registry],
});

const apiCostTotal = new Counter({
  name: "proxy_api_cost_usd_total",
  help: "Total API cost in USD",
  labelNames: ["user_id", "model"],
  registers: [registry],
});

const quotaRejections = new Counter({
  name: "proxy_quota_rejections_total",
  help: "Total requests rejected due to quota",
  labelNames: ["user_id"],
  registers: [registry],
});
```

### Container Stats Collector

```typescript
// packages/platform/src/stats-collector.ts
interface ContainerStats {
  handle: string;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  networkRxBytes: number;
  networkTxBytes: number;
  timestamp: number;
}

class StatsCollector {
  private interval: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;

  constructor(
    private docker: Docker,
    private db: DrizzleDB,
    opts?: { pollIntervalMs?: number },
  ) {
    this.pollIntervalMs = opts?.pollIntervalMs ?? 15_000;
  }

  start(): void;   // poll all running containers on interval
  stop(): void;
  async collectOnce(): Promise<ContainerStats[]>;  // single poll cycle
}
```

Uses `docker.getContainer(id).stats({ stream: false })` for one-shot stats per container. Parses Docker stats JSON into `ContainerStats`. Updates Prometheus gauges on each poll cycle.

### Loki Log Aggregation

Promtail tails:
- `~/matrixos/system/logs/*.jsonl` (interaction logs per container)
- `~/matrixos/system/activity.log` (security + healing events)
- Docker container stdout/stderr via Docker logging driver

Promtail config labels each log stream with `{container="matrixos-{handle}", job="matrixos"}`.

### Grafana Dashboards

Three pre-built dashboards as JSON provisioning files:

1. **Platform Overview**: container count (running/stopped), total cost today, total active WS connections, provision success rate
2. **Container Detail**: per-container CPU, memory, request rate, cost, active sessions (variable: handle)
3. **Cost & Usage**: daily/weekly cost trends, per-user breakdown, model usage distribution, quota utilization

### Alerting Rules

| Alert | Condition | Severity |
|-------|-----------|----------|
| ContainerOOM | memory > 90% of limit for 5m | critical |
| ContainerDown | health check failing for 2m | critical |
| HighCostRate | daily cost > $10/user | warning |
| HighErrorRate | 5xx > 5% of requests for 5m | warning |
| DiskSpaceLow | host disk > 85% | warning |
| DispatchQueueBacklog | queue depth > 10 for 5m | warning |

### Interaction Logger Wiring

Wire `interactionLogger.log()` into the dispatcher's kernel response handler:

```typescript
// packages/gateway/src/dispatcher.ts -- in handleKernelResponse
interactionLogger.log({
  timestamp: new Date().toISOString(),
  source: context.channel ?? "web",
  sessionId: context.sessionId,
  prompt: context.message.slice(0, 500),
  toolsUsed: result.toolsUsed ?? [],
  tokensIn: result.usage?.inputTokens ?? 0,
  tokensOut: result.usage?.outputTokens ?? 0,
  costUsd: result.usage?.costUsd ?? 0,
  durationMs: Date.now() - startTime,
  result: result.status,
});
```

## Dependencies

- Phase 008B (multi-tenant platform) -- complete
- Phase 009 P0 (interaction logger, system info) -- complete

## New Files

| File | Purpose |
|------|---------|
| `packages/gateway/src/metrics.ts` | Gateway Prometheus metrics registry |
| `packages/platform/src/metrics.ts` | Platform Prometheus metrics registry |
| `packages/platform/src/stats-collector.ts` | Docker container stats polling |
| `packages/proxy/src/metrics.ts` | Proxy Prometheus metrics registry |
| `distro/observability/docker-compose.observability.yml` | Grafana + Prometheus + Loki + Promtail |
| `distro/observability/prometheus.yml` | Prometheus scrape config |
| `distro/observability/promtail.yml` | Promtail log tailing config |
| `distro/observability/provisioning/datasources.yml` | Grafana datasource provisioning |
| `distro/observability/dashboards/platform-overview.json` | Platform overview dashboard |
| `distro/observability/dashboards/container-detail.json` | Per-container dashboard |
| `distro/observability/dashboards/cost-usage.json` | Cost and usage dashboard |
| `distro/observability/alerting/rules.yml` | Prometheus alerting rules |
| `tests/platform/stats-collector.test.ts` | Stats collector unit tests |
| `tests/gateway/metrics.test.ts` | Gateway metrics tests |
| `tests/platform/metrics.test.ts` | Platform metrics tests |
| `tests/proxy/metrics.test.ts` | Proxy metrics tests |

## Modified Files

| File | Changes |
|------|---------|
| `packages/gateway/src/server.ts` | Add `/metrics` endpoint, HTTP request instrumentation middleware |
| `packages/gateway/src/dispatcher.ts` | Wire interaction logger, add dispatch counter/histogram |
| `packages/platform/src/main.ts` | Add `/metrics` endpoint, start stats collector |
| `packages/platform/src/orchestrator.ts` | Instrument provision/destroy with histograms |
| `packages/proxy/src/index.ts` | Add `/metrics` endpoint, instrument API calls |
| `distro/docker-compose.platform.yml` | Add observability services (or reference overlay) |

## New Dependencies

| Package | Service | Purpose |
|---------|---------|---------|
| `prom-client` | gateway, platform, proxy | Prometheus metrics library |

No new dependencies for Grafana/Loki/Promtail -- they run as separate containers with official images.
