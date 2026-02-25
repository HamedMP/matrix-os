# Tasks: Container Observability

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T1200-T1229

## User Stories

- **US50**: "I can see CPU, memory, and cost for every running container at a glance"
- **US51**: "I get alerted when a container is unhealthy, OOM, or cost-spiking"
- **US52**: "I can search logs across all containers from one place"
- **US53**: "Every kernel dispatch is logged with cost, tokens, duration, and source"
- **US54**: "I can view historical trends (cost over time, request rates, resource usage)"

---

## Phase A: Service Instrumentation (T1200-T1206)

### Tests (TDD -- write FIRST)

- [ ] T1200a [US53] Write `tests/gateway/metrics.test.ts` (~8 tests):
  - Registry returns Prometheus text format on `/metrics`
  - HTTP request counter increments on requests
  - Kernel dispatch counter increments on dispatch
  - AI cost counter tracks cumulative spend
  - WS connections gauge reflects active connections

- [ ] T1201a [US50] Write `tests/platform/metrics.test.ts` (~6 tests):
  - Container count gauge reflects running/stopped containers
  - Provision histogram records duration
  - `/metrics` endpoint returns valid Prometheus format

- [ ] T1202a [US50] Write `tests/platform/stats-collector.test.ts` (~8 tests):
  - collectOnce returns stats for all running containers
  - CPU percentage calculated correctly from Docker stats JSON
  - Memory usage/limit extracted correctly
  - Handles container that disappears mid-poll (no crash)
  - start/stop manages interval lifecycle
  - Updates Prometheus gauges on each poll

- [ ] T1203a [US53] Write `tests/proxy/metrics.test.ts` (~5 tests):
  - API call counter increments per proxied request
  - Cost counter tracks per-user, per-model spend
  - Quota rejection counter increments on 429

### T1200 [US53] Gateway metrics module
- [ ] Create `packages/gateway/src/metrics.ts`
- [ ] Prometheus registry with: httpRequestsTotal, httpRequestDuration, kernelDispatchTotal, kernelDispatchDuration, wsConnectionsActive, aiCostTotal, aiTokensTotal
- [ ] Export `metricsRegistry` and individual metric objects
- [ ] Add `GET /metrics` endpoint to server.ts (returns `registry.metrics()`)
- **Output**: Gateway exposes Prometheus metrics at `/metrics`

### T1201 [US50] Platform metrics module
- [ ] Create `packages/platform/src/metrics.ts`
- [ ] Prometheus registry with: containersTotal, containerCpuUsage, containerMemoryUsage, containerMemoryLimit, provisionDuration
- [ ] Add `GET /metrics` endpoint to main.ts
- [ ] Instrument `orchestrator.provision()` with histogram
- **Output**: Platform exposes container metrics at `/metrics`

### T1202 [US50] Container stats collector
- [ ] Create `packages/platform/src/stats-collector.ts`
- [ ] `StatsCollector` class: poll all running containers via `docker.getContainer(id).stats({ stream: false })`
- [ ] Parse Docker stats JSON: calculate CPU %, extract memory usage/limit, network rx/tx
- [ ] Update Prometheus gauges on each poll cycle
- [ ] Configurable poll interval (default: 15s)
- [ ] Graceful handling of disappeared containers (log + skip)
- [ ] Start collector in platform main.ts startup, stop on shutdown
- **Output**: Live per-container resource metrics in Prometheus

### T1203 [US53] Proxy metrics module
- [ ] Create `packages/proxy/src/metrics.ts`
- [ ] Prometheus registry with: apiCallsTotal, apiCostTotal, quotaRejections
- [ ] Add `GET /metrics` endpoint to proxy index.ts
- [ ] Instrument API call handler with counter/cost tracking
- **Output**: Proxy exposes API usage metrics at `/metrics`

### T1204 [US53] Wire interaction logger into dispatcher
- [ ] Modify `packages/gateway/src/dispatcher.ts`
- [ ] Call `interactionLogger.log()` after each kernel dispatch completes
- [ ] Extract: source (channel/web), sessionId, prompt (truncated), toolsUsed, tokens, cost, duration, status
- [ ] Ensure logger failures don't break dispatch (try/catch, log error)
- **Output**: Every kernel dispatch recorded in JSONL

### T1205 [US53] HTTP instrumentation middleware
- [ ] Add Hono middleware in gateway server.ts
- [ ] Increment `httpRequestsTotal` on every response (method, path, status labels)
- [ ] Observe `httpRequestDuration` on every response
- [ ] Normalize path labels to prevent cardinality explosion (e.g., `/files/*` not `/files/apps/notes.html`)
- **Output**: All HTTP traffic metered

### T1206 [US53] Dispatch metrics instrumentation
- [ ] Increment `kernelDispatchTotal` on dispatch start (source label)
- [ ] Observe `kernelDispatchDuration` on dispatch complete
- [ ] Increment `aiCostTotal` and `aiTokensTotal` from kernel response usage
- [ ] Update `wsConnectionsActive` gauge on WS connect/disconnect
- **Output**: Kernel dispatch performance and cost tracked

---

## Phase B: Observability Stack (T1210-T1215)

### T1210 Docker Compose observability overlay
- [ ] Create `distro/observability/docker-compose.observability.yml`
- [ ] Services: prometheus (:9090), grafana (:3200), loki (:3100), promtail
- [ ] Prometheus: `prom/prometheus:latest`, volume mount for config + rules
- [ ] Grafana: `grafana/grafana:latest`, volume mount for provisioning + dashboards, anonymous auth enabled
- [ ] Loki: `grafana/loki:latest`, minimal local config
- [ ] Promtail: `grafana/promtail:latest`, volume mount for config + host log paths
- [ ] All services on shared `observability` network + platform network
- [ ] Health checks on all services
- **Output**: `docker compose -f docker-compose.platform.yml -f observability/docker-compose.observability.yml up` starts full stack

### T1211 Prometheus scrape config
- [ ] Create `distro/observability/prometheus.yml`
- [ ] Scrape targets: gateway:4000, platform:9000, proxy:8080
- [ ] Scrape interval: 15s
- [ ] Job names: `gateway`, `platform`, `proxy`
- [ ] Alerting rules file reference
- **Output**: Prometheus scrapes all three services

### T1212 Promtail log tailing config
- [ ] Create `distro/observability/promtail.yml`
- [ ] Tail `~/matrixos/system/logs/*.jsonl` with labels: job=matrixos, type=interaction
- [ ] Tail `~/matrixos/system/activity.log` with labels: job=matrixos, type=activity
- [ ] Docker log driver integration for container stdout/stderr
- [ ] Pipeline stages: JSON parsing for JSONL files, timestamp extraction
- **Output**: All logs flow into Loki

### T1213 Grafana datasource provisioning
- [ ] Create `distro/observability/provisioning/datasources.yml`
- [ ] Prometheus datasource: `http://prometheus:9090`, default
- [ ] Loki datasource: `http://loki:3100`
- **Output**: Grafana auto-discovers both data sources on startup

### T1214 Dashboard provisioning config
- [ ] Create `distro/observability/provisioning/dashboards.yml`
- [ ] Point to `/var/lib/grafana/dashboards` directory
- [ ] Dashboard JSON files auto-loaded on Grafana start
- **Output**: Dashboards appear without manual import

### T1215 Document observability setup
- [ ] Add section to `docs/dev/vps-deployment.md` covering observability stack
- [ ] Include: compose command, default ports, accessing Grafana, adding custom dashboards
- **Output**: Operators know how to deploy and access monitoring

---

## Phase C: Dashboards & Alerts (T1220-T1226)

### T1220 [US50] Platform Overview dashboard
- [ ] Create `distro/observability/dashboards/platform-overview.json`
- [ ] Panels: container count (running/stopped stat), total cost today (stat), active WS connections (stat), provision success rate (stat)
- [ ] Panels: request rate (timeseries), dispatch rate (timeseries), error rate (timeseries)
- [ ] Time range: last 1h default, auto-refresh 30s
- **Output**: Single-pane view of platform health

### T1221 [US50] Container Detail dashboard
- [ ] Create `distro/observability/dashboards/container-detail.json`
- [ ] Variable: `handle` (query from `platform_container_cpu_percent` label values)
- [ ] Panels: CPU % (timeseries), memory usage vs limit (timeseries + threshold), network I/O (timeseries)
- [ ] Panels: request rate for this container, dispatch duration p50/p95/p99, cost today
- [ ] Panels: recent logs (Loki query filtered by container)
- **Output**: Deep dive into any single container

### T1222 [US54] Cost & Usage dashboard
- [ ] Create `distro/observability/dashboards/cost-usage.json`
- [ ] Panels: daily cost trend (timeseries, 7d default), per-user cost breakdown (table), model distribution (pie chart)
- [ ] Panels: tokens in/out trend, cost per dispatch average, quota utilization per user
- [ ] Time range: last 7d default
- **Output**: Cost visibility and trend analysis

### T1223 [US51] Alerting rules
- [ ] Create `distro/observability/alerting/rules.yml`
- [ ] ContainerOOM: `platform_container_memory_bytes / platform_container_memory_limit_bytes > 0.9` for 5m -> critical
- [ ] ContainerDown: `up{job="gateway"} == 0` for 2m -> critical
- [ ] HighCostRate: `increase(proxy_api_cost_usd_total[1d]) > 10` -> warning
- [ ] HighErrorRate: `rate(gateway_http_requests_total{status=~"5.."}[5m]) / rate(gateway_http_requests_total[5m]) > 0.05` -> warning
- [ ] DispatchQueueBacklog: queue depth > 10 for 5m -> warning
- **Output**: Proactive alerting for critical conditions

### T1224 [US51] Grafana alert notification channel
- [ ] Add default notification channel config in provisioning
- [ ] Webhook notification to gateway `/api/alert` endpoint (for shell notification)
- [ ] Optional: email, Slack, Telegram notification channels (configurable)
- **Output**: Alerts reach operators through configured channels

### T1225 Admin dashboard Grafana link
- [ ] Modify `packages/platform/src/main.ts` `/admin/dashboard` response
- [ ] Add `grafanaUrl` field in dashboard JSON response
- [ ] www/ admin page: "Open Grafana" button linking to `:3200`
- **Output**: Easy navigation from admin UI to Grafana

### T1226 [US52] Log exploration knowledge file
- [ ] Create `home/agents/knowledge/observability.md`
- [ ] Document: how to check container health, read metrics, query logs
- [ ] AI can answer "how's my container doing?" by fetching `/metrics` and interpreting
- **Output**: AI assistant can help with monitoring questions

---

## Checkpoint

1. `curl localhost:4000/metrics` -- valid Prometheus text format with all gateway metrics
2. `curl localhost:9000/metrics` -- container CPU/memory gauges populated
3. `curl localhost:8080/metrics` -- API call counters incrementing
4. Send message via web shell -- JSONL entry appears in `~/system/logs/{date}.jsonl`
5. Open Grafana at `:3200` -- three dashboards with live data, no manual config needed
6. Stop a container -- ContainerDown alert fires within 2 minutes
7. `bun run test` passes (all new + existing tests)
8. `docker compose -f docker-compose.platform.yml -f observability/docker-compose.observability.yml up` brings up full stack
