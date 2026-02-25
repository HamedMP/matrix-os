import { Registry, Counter } from "prom-client";

export const proxyMetricsRegistry = new Registry();

export const apiCallsTotal = new Counter({
  name: "proxy_api_calls_total",
  help: "Total API calls proxied",
  labelNames: ["user_id", "model", "status"] as const,
  registers: [proxyMetricsRegistry],
});

export const apiCostTotal = new Counter({
  name: "proxy_api_cost_usd_total",
  help: "Total API cost in USD",
  labelNames: ["user_id", "model"] as const,
  registers: [proxyMetricsRegistry],
});

export const quotaRejections = new Counter({
  name: "proxy_quota_rejections_total",
  help: "Total requests rejected due to quota",
  labelNames: ["user_id"] as const,
  registers: [proxyMetricsRegistry],
});
