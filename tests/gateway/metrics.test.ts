import { describe, it, expect, beforeEach } from "vitest";
import {
  metricsRegistry,
  httpRequestsTotal,
  httpRequestDuration,
  kernelDispatchTotal,
  kernelDispatchDuration,
  wsConnectionsActive,
  aiCostTotal,
  aiTokensTotal,
  normalizePath,
} from "../../packages/gateway/src/metrics.js";

describe("T1200: Gateway metrics module", () => {
  beforeEach(async () => {
    metricsRegistry.resetMetrics();
  });

  it("returns valid Prometheus text format", async () => {
    const output = await metricsRegistry.metrics();
    expect(typeof output).toBe("string");
    expect(output).toContain("# HELP");
    expect(output).toContain("# TYPE");
  });

  it("increments HTTP request counter", async () => {
    httpRequestsTotal.inc({ method: "GET", path: "/health", status: "200" });
    httpRequestsTotal.inc({ method: "GET", path: "/health", status: "200" });

    const output = await metricsRegistry.metrics();
    expect(output).toContain("gateway_http_requests_total");
    expect(output).toContain('method="GET"');
    expect(output).toContain('status="200"');

    const metric = await httpRequestsTotal.get();
    const value = metric.values.find(
      (v) => v.labels.method === "GET" && v.labels.path === "/health" && v.labels.status === "200",
    );
    expect(value?.value).toBe(2);
  });

  it("observes HTTP request duration histogram", async () => {
    httpRequestDuration.observe({ method: "GET", path: "/api/tasks" }, 0.15);

    const output = await metricsRegistry.metrics();
    expect(output).toContain("gateway_http_request_duration_seconds");
    expect(output).toContain("_bucket");
    expect(output).toContain("_sum");
    expect(output).toContain("_count");
  });

  it("increments kernel dispatch counter", async () => {
    kernelDispatchTotal.inc({ source: "web", status: "ok" });
    kernelDispatchTotal.inc({ source: "telegram", status: "error" });

    const metric = await kernelDispatchTotal.get();
    const webOk = metric.values.find(
      (v) => v.labels.source === "web" && v.labels.status === "ok",
    );
    const telegramError = metric.values.find(
      (v) => v.labels.source === "telegram" && v.labels.status === "error",
    );
    expect(webOk?.value).toBe(1);
    expect(telegramError?.value).toBe(1);
  });

  it("tracks AI cost counter", async () => {
    aiCostTotal.inc({ model: "opus-4" }, 0.05);
    aiCostTotal.inc({ model: "opus-4" }, 0.03);
    aiCostTotal.inc({ model: "haiku" }, 0.001);

    const metric = await aiCostTotal.get();
    const opus = metric.values.find((v) => v.labels.model === "opus-4");
    const haiku = metric.values.find((v) => v.labels.model === "haiku");
    expect(opus?.value).toBeCloseTo(0.08);
    expect(haiku?.value).toBeCloseTo(0.001);
  });

  it("tracks AI token counter with direction labels", async () => {
    aiTokensTotal.inc({ model: "opus-4", direction: "input" }, 1000);
    aiTokensTotal.inc({ model: "opus-4", direction: "output" }, 500);

    const metric = await aiTokensTotal.get();
    const input = metric.values.find(
      (v) => v.labels.model === "opus-4" && v.labels.direction === "input",
    );
    const output = metric.values.find(
      (v) => v.labels.model === "opus-4" && v.labels.direction === "output",
    );
    expect(input?.value).toBe(1000);
    expect(output?.value).toBe(500);
  });

  it("changes WS connections gauge up and down", async () => {
    wsConnectionsActive.inc();
    wsConnectionsActive.inc();

    let metric = await wsConnectionsActive.get();
    expect(metric.values[0].value).toBe(2);

    wsConnectionsActive.dec();

    metric = await wsConnectionsActive.get();
    expect(metric.values[0].value).toBe(1);
  });
});

describe("T1205: Path normalization", () => {
  it("collapses /files/* to /files/:path", () => {
    expect(normalizePath("/files/apps/notes.html")).toBe("/files/:path");
    expect(normalizePath("/files/system/theme.json")).toBe("/files/:path");
  });

  it("collapses /modules/* to /modules/:path", () => {
    expect(normalizePath("/modules/todo/index.html")).toBe("/modules/:path");
  });

  it("collapses /api/conversations/:id paths", () => {
    expect(normalizePath("/api/conversations/abc-123")).toBe("/api/conversations/:id");
    expect(normalizePath("/api/conversations/abc-123/search")).toBe("/api/conversations/:id/search");
  });

  it("collapses /api/tasks/:id paths", () => {
    expect(normalizePath("/api/tasks/task-1")).toBe("/api/tasks/:id");
  });

  it("collapses /api/cron/:id paths", () => {
    expect(normalizePath("/api/cron/job-1")).toBe("/api/cron/:id");
  });

  it("preserves known static paths", () => {
    expect(normalizePath("/health")).toBe("/health");
    expect(normalizePath("/metrics")).toBe("/metrics");
    expect(normalizePath("/api/message")).toBe("/api/message");
    expect(normalizePath("/api/layout")).toBe("/api/layout");
    expect(normalizePath("/api/theme")).toBe("/api/theme");
    expect(normalizePath("/api/logs")).toBe("/api/logs");
    expect(normalizePath("/api/apps")).toBe("/api/apps");
    expect(normalizePath("/ws")).toBe("/ws");
  });
});
