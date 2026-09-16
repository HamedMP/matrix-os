import { Registry, Counter, Histogram, Gauge } from "prom-client";

export const metricsRegistry = new Registry();

export const httpRequestsTotal = new Counter({
  name: "gateway_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "path", "status"] as const,
  registers: [metricsRegistry],
});

export const httpRequestDuration = new Histogram({
  name: "gateway_http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "path"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10],
  registers: [metricsRegistry],
});

export const kernelDispatchTotal = new Counter({
  name: "gateway_kernel_dispatch_total",
  help: "Total kernel dispatches",
  labelNames: ["source", "status"] as const,
  registers: [metricsRegistry],
});

export const kernelDispatchDuration = new Histogram({
  name: "gateway_kernel_dispatch_duration_seconds",
  help: "Kernel dispatch duration",
  labelNames: ["source"] as const,
  buckets: [0.5, 1, 5, 10, 30, 60, 120],
  registers: [metricsRegistry],
});

export const wsConnectionsActive = new Gauge({
  name: "gateway_ws_connections_active",
  help: "Active WebSocket connections",
  registers: [metricsRegistry],
});

export const aiCostTotal = new Counter({
  name: "gateway_ai_cost_usd_total",
  help: "Cumulative AI API cost in USD",
  labelNames: ["model"] as const,
  registers: [metricsRegistry],
});

export const aiTokensTotal = new Counter({
  name: "gateway_ai_tokens_total",
  help: "Total AI tokens used",
  labelNames: ["model", "direction"] as const,
  registers: [metricsRegistry],
});

export function normalizePath(path: string): string {
  if (path.startsWith("/files/")) return "/files/:path";
  if (path.startsWith("/modules/")) return "/modules/:path";

  const conversationMatch = path.match(/^\/api\/conversations\/[^/]+/);
  if (conversationMatch) {
    return path.replace(/^\/api\/conversations\/[^/]+/, "/api/conversations/:id");
  }

  if (/^\/api\/tasks\/[^/]+$/.test(path)) return "/api/tasks/:id";
  if (/^\/api\/cron\/[^/]+$/.test(path)) return "/api/cron/:id";
  if (/^\/api\/apps\/[^/]+/.test(path)) return "/api/apps/:slug" + path.replace(/^\/api\/apps\/[^/]+/, "");

  return path;
}
