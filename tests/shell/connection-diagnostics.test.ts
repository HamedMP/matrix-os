import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("connection diagnostics", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies browser offline and deploy restart closes without raw reasons", async () => {
    const { classifySocketClose } = await import("../../shell/src/lib/connection-diagnostics.js");

    expect(classifySocketClose({ code: 1006, wasClean: false }, false)).toBe("browser-network");
    expect(classifySocketClose({ code: 1012, wasClean: false }, true)).toBe("deploy-restart");
    expect(classifySocketClose({ code: 1006, wasClean: false }, true)).toBe("public-route");
  });

  it("keeps a bounded metadata-only diagnostic window", async () => {
    const { getConnectionDiagnostics, recordConnectionDiagnostic } = await import(
      "../../shell/src/lib/connection-diagnostics.js"
    );

    for (let i = 0; i < 55; i++) {
      recordConnectionDiagnostic({
        event: "credential_refresh_failed",
        layer: "credential",
        state: "reconnecting",
        attempt: i,
        route: "/ws",
        visibility: "visible",
      });
    }

    const diagnostics = getConnectionDiagnostics();
    expect(diagnostics).toHaveLength(50);
    expect(diagnostics[0].attempt).toBe(5);
    expect(JSON.stringify(diagnostics)).not.toMatch(/token|private draft|\/home\/matrix|sk_live/i);
  });

  it("summarizes operator diagnostics by metadata-only failure layer", async () => {
    const { recordConnectionDiagnostic, summarizeConnectionDiagnostics } = await import(
      "../../shell/src/lib/connection-diagnostics.js"
    );

    recordConnectionDiagnostic({
      event: "closed",
      layer: "browser-network",
      state: "reconnecting",
      attempt: 1,
      route: "/ws",
      visibility: "hidden",
      closeCode: 1006,
      wasClean: false,
    });
    recordConnectionDiagnostic({
      event: "credential_refresh_failed",
      layer: "credential",
      state: "reconnecting",
      attempt: 2,
      route: "/ws",
      visibility: "visible",
    });
    recordConnectionDiagnostic({
      event: "runtime_probe",
      layer: "runtime-unreachable",
      state: "disconnected",
      attempt: 3,
      route: "/api/system/info",
      runtimeReachability: "unavailable",
    });

    const summary = summarizeConnectionDiagnostics();

    expect(summary).toMatchObject({
      version: 1,
      total: 3,
      byLayer: {
        "browser-network": 1,
        credential: 1,
        "runtime-unreachable": 1,
      },
      latest: {
        event: "runtime_probe",
        layer: "runtime-unreachable",
        route: "/api/system/info",
        runtimeReachability: "unavailable",
      },
    });
    expect(summary.byLayer["public-route"]).toBe(0);
    expect(JSON.stringify(summary)).not.toMatch(/token|private draft|\/home\/matrix|sk_live/i);
  });
});
