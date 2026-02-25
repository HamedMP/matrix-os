# Observability

You can help the user monitor their Matrix OS instance by reading metrics, checking health, and interpreting logs.

## Checking Container Health

- Fetch `GET /health` on the gateway (port 4000) for a quick alive check.
- Fetch `GET /api/system/info` for system details (uptime, memory, versions).
- For platform-level container status, the platform service at port 9000 exposes `/containers` with per-container health.

## Available Metrics

Each service exposes a `/metrics` endpoint in Prometheus text format. You can fetch and interpret these directly.

### Gateway (port 4000)
- `gateway_http_requests_total` -- total HTTP requests (labels: method, path, status)
- `gateway_http_request_duration_seconds` -- request latency histogram
- `gateway_kernel_dispatch_total` -- kernel dispatch count (labels: source, status)
- `gateway_kernel_dispatch_duration_seconds` -- dispatch latency histogram
- `gateway_ws_connections_active` -- current WebSocket connections
- `gateway_ai_cost_usd_total` -- cumulative AI cost in USD (label: model)
- `gateway_ai_tokens_total` -- tokens used (labels: model, direction: input/output)

### Platform (port 9000)
- `platform_containers_total` -- container count by status (running/stopped)
- `platform_container_cpu_percent` -- CPU usage per container (label: handle)
- `platform_container_memory_bytes` -- memory usage per container
- `platform_container_memory_limit_bytes` -- memory limit per container
- `platform_provision_duration_seconds` -- provisioning time histogram

### Proxy (port 8080)
- `proxy_api_calls_total` -- API calls proxied (labels: user_id, model, status)
- `proxy_api_cost_usd_total` -- cost per user and model
- `proxy_quota_rejections_total` -- requests rejected due to quota (label: user_id)

## Reading Logs

- Fetch `GET /api/logs?date=YYYY-MM-DD` to retrieve interaction logs for a specific day.
- Logs are stored as JSONL in `~/system/logs/` with one file per day.
- Each log entry includes: timestamp, source (channel), prompt, tools used, tokens, cost, duration, and result status.

## Answering Common Questions

**"How's my container doing?"**
Fetch `/metrics` from the gateway, look at `gateway_ws_connections_active` for current activity, `gateway_kernel_dispatch_total` for recent dispatches, and report any 5xx errors from `gateway_http_requests_total`.

**"What's my cost today?"**
Check `gateway_ai_cost_usd_total` for cumulative AI spend. The proxy's `proxy_api_cost_usd_total` breaks cost down by user and model.

**"Are there any errors?"**
Look at `gateway_http_requests_total` with status labels in the 4xx/5xx range. Check `gateway_kernel_dispatch_total` for dispatch failures (status=error). Review `/api/logs` for recent entries with error results.

**"How much memory is my container using?"**
Read `platform_container_memory_bytes` and `platform_container_memory_limit_bytes` from platform `/metrics`. Report usage as a percentage of the limit; above 90% is a warning.

## Visual Dashboards

Grafana is available at port 3200 with three pre-built dashboards:
- **Platform Overview**: high-level health, request rates, cost summary
- **Container Detail**: per-container CPU, memory, network, and logs
- **Cost & Usage**: daily trends, per-user breakdown, model distribution

Point the user to `http://localhost:3200` (or their server address on port 3200) if they want interactive visual dashboards.
