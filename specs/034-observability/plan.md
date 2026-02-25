# Plan: Container Observability

**Spec**: `specs/034-observability/spec.md`
**Depends on**: Phase 008B (complete), Phase 009 P0 (complete)
**Estimated effort**: Medium (15 tasks + TDD)

## Approach

Build from the inside out: first instrument the services with Prometheus metrics (immediate value even without Grafana), then wire the broken interaction logger, then deploy the observability stack, then build dashboards and alerts.

### Phase A: Service Instrumentation (T1200-T1206)

Start with metrics endpoints because they're useful standalone (curl, Prometheus, or any scraper). Each service gets a metrics module with a registry and a `/metrics` endpoint.

1. Gateway metrics -- HTTP request counter/histogram, kernel dispatch counter/histogram, WS gauge, AI cost counter
2. Platform metrics -- container count gauge, provision histogram
3. Proxy metrics -- API call counter, cost counter, quota rejection counter
4. Container stats collector -- dockerode `stats({ stream: false })` on interval, feeds platform metrics
5. Wire interaction logger into dispatcher (fix the existing dead code)
6. HTTP instrumentation middleware for gateway (auto-increment counters on every request)

### Phase B: Observability Stack (T1210-T1215)

Deploy Grafana + Prometheus + Loki + Promtail as containers in the platform compose stack. All config is declarative (YAML/JSON provisioning files).

1. Docker Compose overlay file for observability services
2. Prometheus scrape config (gateway, platform, proxy targets)
3. Promtail config (tail JSONL logs, activity.log, Docker stdout)
4. Grafana datasource provisioning (Prometheus + Loki)
5. Dashboard provisioning directory structure

### Phase C: Dashboards & Alerts (T1220-T1226)

Pre-built dashboards that work out of the box. Alerting rules for critical conditions.

1. Platform Overview dashboard (container count, cost, connections)
2. Container Detail dashboard (CPU, memory, requests per container)
3. Cost & Usage dashboard (daily trends, per-user, model distribution)
4. Alerting rules (OOM, container down, high cost, high error rate, disk)
5. Admin dashboard enhancement -- link to Grafana from existing `/admin/dashboard`

## Files to Create

- `packages/gateway/src/metrics.ts`
- `packages/platform/src/metrics.ts`
- `packages/platform/src/stats-collector.ts`
- `packages/proxy/src/metrics.ts`
- `distro/observability/docker-compose.observability.yml`
- `distro/observability/prometheus.yml`
- `distro/observability/promtail.yml`
- `distro/observability/provisioning/datasources.yml`
- `distro/observability/dashboards/platform-overview.json`
- `distro/observability/dashboards/container-detail.json`
- `distro/observability/dashboards/cost-usage.json`
- `distro/observability/alerting/rules.yml`
- All corresponding test files

## Files to Modify

- `packages/gateway/src/server.ts` -- `/metrics` endpoint + HTTP middleware
- `packages/gateway/src/dispatcher.ts` -- wire interaction logger + dispatch metrics
- `packages/platform/src/main.ts` -- `/metrics` endpoint + stats collector startup
- `packages/platform/src/orchestrator.ts` -- provision/destroy histograms
- `packages/proxy/src/index.ts` -- `/metrics` endpoint + API call instrumentation
- `distro/docker-compose.platform.yml` -- reference observability overlay

## Verification

1. `curl localhost:4000/metrics` returns Prometheus text format
2. `curl localhost:9000/metrics` returns platform container gauges
3. `curl localhost:8080/metrics` returns proxy API call counters
4. Grafana at `:3200` shows all three dashboards with live data
5. Send a message via web shell -- interaction logger writes JSONL entry
6. Kill a container -- alert fires in Grafana within 2 minutes
7. `bun run test` passes (all new + existing tests)
