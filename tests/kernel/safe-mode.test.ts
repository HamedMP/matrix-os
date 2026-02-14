import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSafeModePrompt,
  safeModeAgentDef,
} from "../../packages/kernel/src/safe-mode.js";

function tmpHome(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "safemode-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  mkdirSync(join(dir, "system", "logs"), { recursive: true });
  return dir;
}

describe("T204: Safe mode agent", () => {
  it("agent definition uses sonnet model", () => {
    expect(safeModeAgentDef.model).toContain("sonnet");
  });

  it("agent definition has restricted tools", () => {
    expect(safeModeAgentDef.disallowedTools).toContain("agent");
  });

  it("prompt includes diagnostic instructions", () => {
    const homePath = tmpHome();
    const prompt = buildSafeModePrompt(homePath);
    expect(prompt).toContain("SAFE MODE");
    expect(prompt).toContain("diagnose");
    rmSync(homePath, { recursive: true, force: true });
  });

  it("prompt includes recent error context when available", () => {
    const homePath = tmpHome();
    const logPath = join(homePath, "system", "activity.log");
    writeFileSync(logPath, "[2026-01-01] [error] Module crashed\n[2026-01-01] [error] Kernel timeout\n");
    const prompt = buildSafeModePrompt(homePath);
    expect(prompt).toContain("Module crashed");
    rmSync(homePath, { recursive: true, force: true });
  });

  it("prompt works without activity log", () => {
    const homePath = tmpHome();
    const prompt = buildSafeModePrompt(homePath);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    rmSync(homePath, { recursive: true, force: true });
  });
});
