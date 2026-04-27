import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getSystemInfo, getVersion } from "../../packages/gateway/src/system-info.js";

function tmpHome(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "sysinfo-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  mkdirSync(join(dir, "modules"), { recursive: true });
  mkdirSync(join(dir, "agents"), { recursive: true });
  return dir;
}

describe("T135: System info", () => {
  it("includes image provenance from build environment", () => {
    const homePath = tmpHome();
    const previousSha = process.env.MATRIX_BUILD_SHA;
    const previousRef = process.env.MATRIX_BUILD_REF;
    const previousDate = process.env.MATRIX_BUILD_DATE;
    process.env.MATRIX_BUILD_SHA = "abc1234";
    process.env.MATRIX_BUILD_REF = "main";
    process.env.MATRIX_BUILD_DATE = "2026-04-26T16:17:05Z";

    try {
      const info = getSystemInfo(homePath);

      expect(info.build).toEqual({
        sha: "abc1234",
        ref: "main",
        date: "2026-04-26T16:17:05Z",
      });
    } finally {
      if (previousSha === undefined) delete process.env.MATRIX_BUILD_SHA;
      else process.env.MATRIX_BUILD_SHA = previousSha;
      if (previousRef === undefined) delete process.env.MATRIX_BUILD_REF;
      else process.env.MATRIX_BUILD_REF = previousRef;
      if (previousDate === undefined) delete process.env.MATRIX_BUILD_DATE;
      else process.env.MATRIX_BUILD_DATE = previousDate;
      rmSync(homePath, { recursive: true, force: true });
    }
  });

  it("returns version and uptime", () => {
    const homePath = tmpHome();
    const info = getSystemInfo(homePath);
    expect(info.version).toBeDefined();
    expect(info.uptime).toBeGreaterThanOrEqual(0);
    rmSync(homePath, { recursive: true, force: true });
  });

  it("counts modules from modules.json", () => {
    const homePath = tmpHome();
    writeFileSync(
      join(homePath, "system", "modules.json"),
      JSON.stringify([
        { name: "todo", port: 3100, status: "running" },
        { name: "notes", port: 3101, status: "stopped" },
      ]),
    );
    const info = getSystemInfo(homePath);
    expect(info.modules).toBe(2);
    rmSync(homePath, { recursive: true, force: true });
  });

  it("handles missing modules.json", () => {
    const homePath = tmpHome();
    const info = getSystemInfo(homePath);
    expect(info.modules).toBe(0);
    rmSync(homePath, { recursive: true, force: true });
  });

  it("reads channel config", () => {
    const homePath = tmpHome();
    writeFileSync(
      join(homePath, "system", "config.json"),
      JSON.stringify({
        channels: {
          telegram: { enabled: true, token: "x" },
          discord: { enabled: false },
        },
      }),
    );
    const info = getSystemInfo(homePath);
    expect(info.channels.telegram).toBe(true);
    expect(info.channels.discord).toBe(false);
    rmSync(homePath, { recursive: true, force: true });
  });

  it("counts skills", () => {
    const homePath = tmpHome();
    mkdirSync(join(homePath, "agents", "skills"), { recursive: true });
    writeFileSync(join(homePath, "agents", "skills", "summarize.md"), "---\nname: summarize\n---\n");
    writeFileSync(join(homePath, "agents", "skills", "reminder.md"), "---\nname: reminder\n---\n");
    const info = getSystemInfo(homePath);
    expect(info.skills).toBe(2);
    rmSync(homePath, { recursive: true, force: true });
  });
});

describe("getVersion", () => {
  it("falls back to package.json version in dev", () => {
    const version = getVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns a non-empty string", () => {
    expect(getVersion().length).toBeGreaterThan(0);
  });
});
