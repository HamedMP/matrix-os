import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DASHBOARDS_DIR = join(__dirname, "../../distro/observability/dashboards");
const ALERTING_DIR = join(__dirname, "../../distro/observability/alerting");

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
    for (const file of ["platform-overview.json", "vps-fleet-overview.json"]) {
      const raw = readFileSync(join(DASHBOARDS_DIR, file), "utf-8");
      expect(raw).toContain('"uid": "prometheus"');
    }
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
  });
});

describe("alerting rules", () => {
  it("contains VPS alert rules", () => {
    const raw = readFileSync(join(ALERTING_DIR, "rules.yml"), "utf-8");

    expect(raw).toContain("VpsInstanceUnreachable");
    expect(raw).toContain("VpsStaleVersion");
    expect(raw).toContain("VpsProvisioningStuck");
    expect(raw).toContain("matrixos-vps");
  });
});
