import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runSecurityAudit,
  type SecurityAuditReport,
} from "../../packages/kernel/src/security/audit.js";

describe("T832: Security audit engine", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "audit-"));
    mkdirSync(join(homePath, "system"), { recursive: true });
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({
        auth: { token: "${MATRIX_AUTH_TOKEN}" },
        channels: {},
      }),
    );
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("produces a structured SecurityAuditReport", async () => {
    const report = await runSecurityAudit(homePath);
    expect(report.timestamp).toBeTruthy();
    expect(report.findings).toBeInstanceOf(Array);
    expect(report.summary).toHaveProperty("info");
    expect(report.summary).toHaveProperty("warn");
    expect(report.summary).toHaveProperty("critical");
  });

  it("detects weak auth token (<24 chars)", async () => {
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({ auth: { token: "short" } }),
    );
    const report = await runSecurityAudit(homePath);
    const finding = report.findings.find((f) => f.checkId === "weak-auth-token");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warn");
  });

  it("detects secrets baked into config (not ${VAR} refs)", async () => {
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({
        auth: { token: "sk-ant-api-key-baked-in-directly" },
      }),
    );
    const report = await runSecurityAudit(homePath);
    const finding = report.findings.find((f) => f.checkId === "baked-secret");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("critical");
  });

  it("passes clean config with env refs", async () => {
    const report = await runSecurityAudit(homePath);
    const baked = report.findings.find((f) => f.checkId === "baked-secret");
    expect(baked).toBeUndefined();
  });

  it("detects world-readable config file", async () => {
    try {
      chmodSync(join(homePath, "system/config.json"), 0o644);
    } catch {
      return; // Skip on platforms that don't support chmod
    }
    const report = await runSecurityAudit(homePath);
    const finding = report.findings.find((f) => f.checkId === "config-permissions");
    expect(finding).toBeDefined();
  });

  it("summary counts match findings", async () => {
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({ auth: { token: "short" } }),
    );
    const report = await runSecurityAudit(homePath);
    const infos = report.findings.filter((f) => f.severity === "info").length;
    const warns = report.findings.filter((f) => f.severity === "warn").length;
    const crits = report.findings.filter((f) => f.severity === "critical").length;
    expect(report.summary).toEqual({ info: infos, warn: warns, critical: crits });
  });
});
