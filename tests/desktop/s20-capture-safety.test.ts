import { describe, expect, it, vi } from "vitest";
import {
  captureStep,
  cleanupWithRestore,
  recordBoundedDiagnostic,
} from "../../specs/124-organization-collaboration/evidence/S20-audience/capture-safety.js";

describe("S20 Electron evidence capture safety", () => {
  it("fails the run when required Terminal or Chat capture fails", async () => {
    for (const name of ["terminal", "chat"]) {
      const failure = new Error(`${name} dialog missing`);
      const report = vi.fn(async () => {});
      await expect(captureStep(name, async () => { throw failure; }, report)).rejects.toBe(failure);
      expect(report).toHaveBeenCalledWith(name, failure);
    }
  });

  it("records a known optional Project capture failure without failing the run", async () => {
    const report = vi.fn(async () => {});
    expect(await captureStep("project", async () => { throw new Error("unreachable project"); }, report, true)).toBe(false);
    expect(report).toHaveBeenCalledOnce();
  });

  it("restores the built renderer even if earlier cleanup fails", async () => {
    const restore = vi.fn();
    await expect(cleanupWithRestore(async () => { throw new Error("gateway close failed"); }, restore))
      .rejects.toThrow("gateway close failed");
    expect(restore).toHaveBeenCalledOnce();
  });

  it("retains only the newest 50 unmatched request diagnostics", () => {
    const diagnostics = new Set<string>();
    for (let index = 0; index < 51; index += 1) recordBoundedDiagnostic(diagnostics, `request-${index}`);
    expect(diagnostics.size).toBe(50);
    expect(diagnostics.has("request-0")).toBe(false);
    expect(diagnostics.has("request-50")).toBe(true);
  });
});
