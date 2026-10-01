import { describe, expect, it, vi } from "vitest";
import { evaluateCatalog, runPreflight } from "../../scripts/dev-preflight.mjs";

describe("local demo preflight", () => {
  it("requires an available Aoede-capable provider route", () => {
    expect(evaluateCatalog({ instances: [] })).toMatchObject({ level: "FAIL" });
    expect(evaluateCatalog({ instances: [{
      availability: "available",
      models: [{ availability: "available", capabilities: ["reasoning", "tools"] }],
      supports: { rootChat: true, interactionModes: ["default"] },
    }] })).toMatchObject({ level: "PASS" });
  });

  it("fails closed when authenticated checks cannot authenticate", async () => {
    const result = await runPreflight({
      command: vi.fn(async () => ({ ok: true })),
      platformHealth: vi.fn(async () => ({ status: 200, json: { status: "ok" } })),
      authenticatedGet: vi.fn(async () => ({ status: 401, json: { error: "unauthorized" } })),
    });
    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.id === "provider-catalog")).toMatchObject({ level: "FAIL" });
  });

  it("treats unavailable optional integrations as a warning", async () => {
    const authenticatedGet = vi.fn(async (path: string) => {
      if (path === "/api/chat-providers") return { status: 200, json: { instances: [{
        availability: "available",
        models: [{ availability: "available", capabilities: ["reasoning", "tools"] }],
        supports: { rootChat: true, interactionModes: ["default"] },
      }] } };
      if (path === "/api/integrations/capabilities") return { status: 200, json: { capabilities: [] } };
      return { status: 503, json: { error: "integrations_unavailable" } };
    });
    const result = await runPreflight({
      command: vi.fn(async () => ({ ok: true })),
      platformHealth: vi.fn(async () => ({ status: 200, json: { status: "ok" } })),
      authenticatedGet,
    });
    expect(result.exitCode).toBe(0);
    expect(result.checks.find((check) => check.id === "integrations")).toMatchObject({ level: "WARN" });
    expect(result.checks.find((check) => check.id === "paid-voice-e2e")).toMatchObject({ level: "WARN" });
  });

  it("returns nonzero when a required runtime capability is missing", async () => {
    const result = await runPreflight({
      command: vi.fn(async (id: string) => ({ ok: id !== "terminal-service" })),
      platformHealth: vi.fn(async () => ({ status: 200, json: {} })),
      authenticatedGet: vi.fn(async () => ({ status: 200, json: { instances: [{
        availability: "available", models: [{ availability: "available", capabilities: ["reasoning", "tools"] }],
        supports: { rootChat: true, interactionModes: ["default"] },
      }] } })),
    });
    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.id === "terminal-service")).toMatchObject({ level: "FAIL" });
  });
});
