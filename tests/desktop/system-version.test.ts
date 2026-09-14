import { describe, expect, it } from "vitest";
import { readSystemVersionIdentity } from "../../desktop/src/renderer/src/lib/system-version";

describe("desktop system version identity", () => {
  it("prefers installed release provenance over the legacy app version field", () => {
    expect(readSystemVersionIdentity({
      version: "0.1.0",
      runningVersion: "v2026.08.20",
      release: { version: "v2026.08.20" },
    })).toEqual({
      installedVersion: "v2026.08.20",
      runningVersion: "v2026.08.20",
    });
  });

  it("falls back to the legacy app version when release metadata is absent", () => {
    expect(readSystemVersionIdentity({
      version: "v2026.08.18-997",
      runningVersion: "v2026.08.18-997",
    })).toEqual({
      installedVersion: "v2026.08.18-997",
      runningVersion: "v2026.08.18-997",
    });
  });
});
