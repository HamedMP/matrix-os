import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DASHBOARDS_DIR = join(__dirname, "../../distro/observability/dashboards");
const ALERTING_DIR = join(__dirname, "../../distro/observability/alerting");

function dashboardFiles(): string[] {
  return readdirSync(DASHBOARDS_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort();
}

describe("grafana dashboards", () => {
  it("vps-fleet-overview.json is valid JSON with required fields", () => {
    const raw = readFileSync(join(DASHBOARDS_DIR, "vps-fleet-overview.json"), "utf-8");
    const dashboard = JSON.parse(raw);

    expect(dashboard.title).toBe("VPS Fleet Overview");
    expect(dashboard.uid).toBe("matrix-vps-fleet");
    expect(Array.isArray(dashboard.panels)).toBe(true);
    expect(dashboard.panels.length).toBeGreaterThan(0);
  });

  it("all dashboard files reference the prometheus datasource uid", () => {
    for (const file of dashboardFiles()) {
      const raw = readFileSync(join(DASHBOARDS_DIR, file), "utf-8");
      expect(raw).toContain('"uid": "prometheus"');
    }
  });

  it("retires the legacy per-container detail dashboard", () => {
    expect(existsSync(join(DASHBOARDS_DIR, "container-detail.json"))).toBe(false);
  });

  it("vps-fleet-overview uses matrix_vps_ metric prefix", () => {
    const raw = readFileSync(join(DASHBOARDS_DIR, "vps-fleet-overview.json"), "utf-8");
    const dashboard = JSON.parse(raw);

    const allExprs = dashboard.panels
      .flatMap((p: { targets?: Array<{ expr: string }> }) => p.targets ?? [])
      .map((t: { expr: string }) => t.expr);

    expect(allExprs.length).toBeGreaterThan(0);
    for (const expr of allExprs) {
      expect(expr).toMatch(/matrix_vps_/);
    }
    expect(allExprs).toContain('matrix_vps_load1{handle="$handle"}');
    expect(allExprs).toContain('matrix_vps_probe_latency_seconds{handle="$handle"}');
    expect(allExprs).toContain("max(1 - (matrix_vps_disk_free_bytes / matrix_vps_disk_total_bytes))");
    expect(allExprs).toContain("max(1 - (matrix_vps_memory_free_bytes / matrix_vps_memory_total_bytes))");
  });

  it("vps-detail exposes selected VPS runtime and identity panels", () => {
    const raw = readFileSync(join(DASHBOARDS_DIR, "vps-detail.json"), "utf-8");
    const dashboard = JSON.parse(raw);

    const allExprs = dashboard.panels
      .flatMap((p: { targets?: Array<{ expr: string }> }) => p.targets ?? [])
      .map((t: { expr: string }) => t.expr);

    expect(dashboard.uid).toBe("matrix-vps-detail");
    expect(allExprs).toContain('matrix_vps_load1{handle="$handle"}');
    expect(allExprs).toContain('matrix_user_vps_link{handle="$handle"}');
  });

  it("users dashboard exposes Clerk user to VPS mappings", () => {
    const raw = readFileSync(join(DASHBOARDS_DIR, "users-vps-connections.json"), "utf-8");
    const dashboard = JSON.parse(raw);

    const allExprs = dashboard.panels
      .flatMap((p: { targets?: Array<{ expr: string }> }) => p.targets ?? [])
      .map((t: { expr: string }) => t.expr);

    expect(dashboard.uid).toBe("matrix-users-vps-connections");
    expect(allExprs).toContain("matrix_user_vps_link");
    expect(allExprs).toContain('matrix_platform_users_total{kind="total"}');
  });

  it("release dashboard exposes channel pointers", () => {
    const raw = readFileSync(join(DASHBOARDS_DIR, "release-channels.json"), "utf-8");
    const dashboard = JSON.parse(raw);

    const allExprs = dashboard.panels
      .flatMap((p: { targets?: Array<{ expr: string }> }) => p.targets ?? [])
      .map((t: { expr: string }) => t.expr);

    expect(dashboard.uid).toBe("matrix-release-channels");
    expect(allExprs).toContain("matrix_release_channel_info");
    expect(allExprs).toContain("matrix_release_channel_bundle_bytes");
  });

  it("system health dashboard tracks platform, proxy, fleet, and users", () => {
    const raw = readFileSync(join(DASHBOARDS_DIR, "matrix-system-health.json"), "utf-8");
    const dashboard = JSON.parse(raw);

    const allExprs = dashboard.panels
      .flatMap((p: { targets?: Array<{ expr: string }> }) => p.targets ?? [])
      .map((t: { expr: string }) => t.expr);

    expect(dashboard.uid).toBe("matrix-system-health");
    expect(allExprs).toContain('up{job="platform"}');
    expect(allExprs).toContain('up{job="proxy"}');
    expect(allExprs).toContain('matrix_platform_users_total{kind="total"}');
  });

  it("platform overview tracks request latency and platform runtime load", () => {
    const raw = readFileSync(join(DASHBOARDS_DIR, "platform-overview.json"), "utf-8");
    const dashboard = JSON.parse(raw);

    const allExprs = dashboard.panels
      .flatMap((p: { targets?: Array<{ expr: string }> }) => p.targets ?? [])
      .map((t: { expr: string }) => t.expr);

    expect(allExprs.some((expr) => expr.includes("platform_http_request_duration_seconds_bucket"))).toBe(true);
    expect(allExprs.some((expr) => expr.includes("platform_http_requests_total"))).toBe(true);
    expect(allExprs).toContain("platform_container_cpu_percent");
    expect(allExprs).toContain("platform_container_memory_bytes / platform_container_memory_limit_bytes");
  });
});

describe("alerting rules", () => {
  it("contains VPS alert rules", () => {
    const raw = readFileSync(join(ALERTING_DIR, "rules.yml"), "utf-8");

    expect(raw).toContain("VpsInstanceUnreachable");
    expect(raw).toContain("VpsVersionDrift");
    expect(raw).toContain("VpsProvisioningStuck");
    expect(raw).toContain("matrixos-vps");
  });

  it("alerts on any VPS provision failure within 15 minutes", () => {
    const raw = readFileSync(join(ALERTING_DIR, "rules.yml"), "utf-8");

    expect(raw).toContain("VpsProvisionFailed");
    expect(raw).toContain("increase(matrix_vps_provision_failures_total[15m]) > 0");
  });
});
