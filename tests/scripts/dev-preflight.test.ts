import { describe, expect, it, vi } from "vitest";
import { evaluateCatalog, runPreflight } from "../../scripts/dev-preflight.mjs";

const codexCatalog = { instances: [{
  id: "codex_default", driverKind: "codex", availability: "available",
  models: [{ id: "gpt-5.6-sol", availability: "available", capabilities: ["reasoning", "tools"] }],
  supports: { rootChat: true, interactionModes: ["default"] },
}] };
const codexChat = { chat: { id: "chat_codex", currentSelection: { instanceId: "codex_default", model: "gpt-5.6-sol" } } };
const voiceAvailable = {
  status: "available", actionMode: "canonical_actions",
  transportModes: ["relayed_websocket"], turnModes: ["hands_free", "push_to_talk"],
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    command: vi.fn(async () => ({ ok: true })),
    platformHealth: vi.fn(async () => ({ status: 200, json: { status: "ok" } })),
    authenticatedGet: vi.fn(async (path: string) => {
      if (path === "/api/chat-providers") return { status: 200, json: codexCatalog };
      if (path === "/api/chats?limit=100") return { status: 200, json: { items: [codexChat] } };
      if (path === "/api/chats/chat_codex/voice/capabilities?surface=web_desktop") return { status: 200, json: voiceAvailable };
      if (path === "/api/integrations/capabilities") return { status: 200, json: { capabilities: [] } };
      return { status: 200, json: [] };
    }),
    ...overrides,
  };
}

describe("local demo preflight", () => {
  it("accepts only an available canonical Codex route", () => {
    expect(evaluateCatalog({ instances: [] })).toMatchObject({ check: { level: "FAIL" } });
    expect(evaluateCatalog(codexCatalog)).toMatchObject({ check: { level: "PASS" }, instanceIds: ["codex_default"] });
    expect(evaluateCatalog({ instances: [{ ...codexCatalog.instances[0], id: "pi_default", driverKind: "pi" }] }))
      .toMatchObject({ check: { level: "FAIL" } });
  });

  it("fails when a general provider is available but no Codex route is available", async () => {
    const generalCatalog = { instances: [{ ...codexCatalog.instances[0], id: "pi_default", driverKind: "pi" }] };
    const result = await runPreflight(dependencies({
      authenticatedGet: vi.fn(async (path: string) => path === "/api/chat-providers"
        ? { status: 200, json: generalCatalog } : { status: 200, json: { items: [codexChat] } }),
    }));
    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.id === "aoede")).toMatchObject({ level: "FAIL" });
  });

  it.each([
    ["voice unavailable", { ...voiceAvailable, status: "unavailable" }],
    ["conversation only", { ...voiceAvailable, actionMode: "conversation_only" }],
  ])("fails when %s", async (_name, capability) => {
    const deps = dependencies();
    deps.authenticatedGet.mockImplementation(async (path: string) => {
      if (path === "/api/chat-providers") return { status: 200, json: codexCatalog };
      if (path === "/api/chats?limit=100") return { status: 200, json: { items: [codexChat] } };
      if (path.includes("/voice/capabilities")) return { status: 200, json: capability };
      return { status: 200, json: {} };
    });
    const result = await runPreflight(deps);
    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.id === "aoede")).toMatchObject({ level: "FAIL" });
  });

  it("fails closed when voice capability authentication is denied", async () => {
    const deps = dependencies();
    deps.authenticatedGet.mockImplementation(async (path: string) => {
      if (path === "/api/chat-providers") return { status: 200, json: codexCatalog };
      if (path === "/api/chats?limit=100") return { status: 200, json: { items: [codexChat] } };
      if (path.includes("/voice/capabilities")) return { status: 403, json: { error: "forbidden" } };
      return { status: 200, json: {} };
    });
    const result = await runPreflight(deps);
    expect(result.checks.find((check) => check.id === "voice-capabilities")).toMatchObject({ level: "FAIL", detail: "authentication was not accepted" });
    expect(result.exitCode).toBe(1);
  });

  it("fails with non-mutating recovery guidance when no matching Chat exists", async () => {
    const deps = dependencies();
    deps.authenticatedGet.mockImplementation(async (path: string) => {
      if (path === "/api/chat-providers") return { status: 200, json: codexCatalog };
      if (path === "/api/chats?limit=100") return { status: 200, json: { items: [] } };
      return { status: 200, json: {} };
    });
    const result = await runPreflight(deps);
    expect(result.checks.find((check) => check.id === "aoede")).toMatchObject({ level: "FAIL" });
    expect(result.checks.find((check) => check.id === "aoede")?.detail).toContain("Open Aoede once");
    expect(deps.authenticatedGet.mock.calls.some(([path]) => String(path).includes("voice/capabilities"))).toBe(false);
  });

  it("passes only with an existing Codex Chat and full voice readiness, retaining the Pipedream warning", async () => {
    const deps = dependencies();
    deps.authenticatedGet.mockImplementation(async (path: string) => {
      if (path === "/api/chat-providers") return { status: 200, json: codexCatalog };
      if (path === "/api/chats?limit=100") return { status: 200, json: { items: [codexChat] } };
      if (path.includes("/voice/capabilities")) return { status: 200, json: voiceAvailable };
      if (path === "/api/integrations/capabilities") return { status: 200, json: {} };
      return { status: 503, json: { error: "integrations_unavailable" } };
    });
    const result = await runPreflight(deps);
    expect(result.exitCode).toBe(0);
    expect(result.checks.find((check) => check.id === "aoede")).toMatchObject({ level: "PASS" });
    expect(result.checks.find((check) => check.id === "integrations")).toMatchObject({ level: "WARN" });
    expect(deps.authenticatedGet).toHaveBeenCalledWith("/api/integrations/available");
  });
});
