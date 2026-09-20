import { describe, it, expect, beforeEach } from "vitest";
import {
  proxyMetricsRegistry,
  apiCallsTotal,
  apiCostTotal,
  quotaRejections,
} from "../../packages/proxy/src/metrics.js";

describe("T1203: Proxy metrics module", () => {
  beforeEach(async () => {
    proxyMetricsRegistry.resetMetrics();
  });

  it("returns valid Prometheus text format", async () => {
    const output = await proxyMetricsRegistry.metrics();
    expect(typeof output).toBe("string");
    expect(output).toContain("# HELP");
    expect(output).toContain("# TYPE");
  });

  it("increments API call counter with labels", async () => {
    apiCallsTotal.inc({ user_id: "user1", model: "opus-4", status: "200" });
    apiCallsTotal.inc({ user_id: "user1", model: "opus-4", status: "200" });
    apiCallsTotal.inc({ user_id: "user2", model: "haiku", status: "500" });

    const metric = await apiCallsTotal.get();
    const user1Ok = metric.values.find(
      (v) => v.labels.user_id === "user1" && v.labels.status === "200",
    );
    const user2Err = metric.values.find(
      (v) => v.labels.user_id === "user2" && v.labels.status === "500",
    );
    expect(user1Ok?.value).toBe(2);
    expect(user2Err?.value).toBe(1);
  });

  it("tracks cost per user and model", async () => {
    apiCostTotal.inc({ user_id: "user1", model: "opus-4" }, 0.05);
    apiCostTotal.inc({ user_id: "user1", model: "opus-4" }, 0.03);
    apiCostTotal.inc({ user_id: "user2", model: "haiku" }, 0.001);

    const metric = await apiCostTotal.get();
    const user1Opus = metric.values.find(
      (v) => v.labels.user_id === "user1" && v.labels.model === "opus-4",
    );
    const user2Haiku = metric.values.find(
      (v) => v.labels.user_id === "user2" && v.labels.model === "haiku",
    );
    expect(user1Opus?.value).toBeCloseTo(0.08);
    expect(user2Haiku?.value).toBeCloseTo(0.001);
  });

  it("increments quota rejection counter", async () => {
    quotaRejections.inc({ user_id: "user1" });
    quotaRejections.inc({ user_id: "user1" });
    quotaRejections.inc({ user_id: "user2" });

    const metric = await quotaRejections.get();
    const user1 = metric.values.find((v) => v.labels.user_id === "user1");
    const user2 = metric.values.find((v) => v.labels.user_id === "user2");
    expect(user1?.value).toBe(2);
    expect(user2?.value).toBe(1);
  });

  it("metrics output contains all metric names", async () => {
    apiCallsTotal.inc({ user_id: "u", model: "m", status: "200" });
    apiCostTotal.inc({ user_id: "u", model: "m" }, 0.01);
    quotaRejections.inc({ user_id: "u" });

    const output = await proxyMetricsRegistry.metrics();
    expect(output).toContain("proxy_api_calls_total");
    expect(output).toContain("proxy_api_cost_usd_total");
    expect(output).toContain("proxy_quota_rejections_total");
  });
});
