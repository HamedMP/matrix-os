import { describe, expect, it } from "vitest";
import { normalizeMatrixOsHandleCandidate } from "../../packages/clerk-sync/src/index.js";

describe("normalizeMatrixOsHandleCandidate", () => {
  it("normalizes separators and trims dashes", () => {
    expect(normalizeMatrixOsHandleCandidate("--Ada  Lovelace--")).toBe("ada-lovelace");
  });

  it("stays linear on long separator runs", () => {
    const started = performance.now();
    expect(normalizeMatrixOsHandleCandidate(`${"-".repeat(100_000)}ada${"!".repeat(100_000)}`)).toBe("ada");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
