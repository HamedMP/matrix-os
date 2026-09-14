import { describe, expect, it, vi } from "vitest";
import { createProviderDriverInventoryReader } from "../../packages/gateway/src/ai-providers/provider-driver-inventory.js";

describe("provider settings driver inventory", () => {
  it("maps the existing runtime and executable probes into the six real harness drivers", async () => {
    const detectAgentInstallations = vi.fn(async () => ({
      agents: [
        { id: "claude", command: "claude", displayName: "Claude", installState: "installed", installed: true, authState: "ok", workspaceCompatibility: "not_applicable", version: "2.1.251", errorCode: null },
        { id: "codex", command: "codex", displayName: "Codex", installState: "installed", installed: true, authState: "required", workspaceCompatibility: "compatible", version: "0.147.0", errorCode: null },
        { id: "opencode", command: "opencode", displayName: "OpenCode", installState: "missing", installed: false, authState: "unknown", workspaceCompatibility: "not_applicable", errorCode: null },
        { id: "pi", command: "pi", displayName: "Pi", installState: "unknown", installed: null, authState: "unknown", workspaceCompatibility: "not_applicable", errorCode: null },
      ],
    }));
    const runtimeSource = vi.fn(async () => ({
      runtime: {
        selected: "hermes" as const,
        transition: null,
        options: [
          { id: "hermes" as const, displayName: "Hermes", installState: "installed" as const, health: "healthy" as const, selectionState: "active" as const, configured: true, capabilities: ["provider_catalog" as const, "model_selection" as const] },
          { id: "openclaw" as const, displayName: "OpenClaw", installState: "missing" as const, health: "stopped" as const, selectionState: "action_required" as const, configured: false, capabilities: ["install" as const], setupAction: "install" as const },
        ],
      },
      providers: [],
      messaging: { runtime: "hermes" as const, provider: "anthropic", model: "claude-sonnet-5", configured: true },
    }));
    const read = createProviderDriverInventoryReader({ detectAgentInstallations, runtimeSource });
    const drivers = await read(AbortSignal.timeout(1_000));

    expect(drivers.map((driver) => driver.id)).toEqual([
      "hermes", "openclaw", "claude_code", "codex", "opencode", "pi",
    ]);
    expect(drivers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "hermes", installState: "installed", health: "ready" }),
      expect.objectContaining({ id: "openclaw", installState: "missing", setupActions: ["install"] }),
      expect.objectContaining({ id: "claude_code", installState: "installed", health: "ready", setupActions: [] }),
      expect.objectContaining({ id: "codex", installState: "installed", health: "stopped", setupActions: ["connect_account", "open_terminal"] }),
      expect.objectContaining({ id: "opencode", installState: "missing", setupActions: ["install"] }),
    ]));
  });

  it("verifies both canonical inventory dependencies at registration time", () => {
    expect(() => createProviderDriverInventoryReader({
      detectAgentInstallations: undefined as never,
      runtimeSource: vi.fn(),
    })).toThrow("Agent installation inventory is required");
    expect(() => createProviderDriverInventoryReader({
      detectAgentInstallations: vi.fn(),
      runtimeSource: undefined as never,
    })).toThrow("Agent runtime inventory is required");
  });
});
