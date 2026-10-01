// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openWebProviderAgentSetup } from "../../shell/src/lib/provider-settings-transport.js";
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import { openDesktopProviderAgentSetup } from "../../desktop/src/renderer/src/features/settings/provider-settings-desktop-adapter.js";

describe("Settings catalog connection-label negotiation", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("opts Web Settings into labels while requesting a fresh catalog", async () => {
    const fetcher = vi.fn(async () => Response.json({ revision: "revision", drivers: [], instances: [] }));
    vi.stubGlobal("fetch", fetcher);
    expect(await openWebProviderAgentSetup("pi", vi.fn())).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/api/chat-providers?refresh=true&includeConnectionLabels=true&includeSettingsSetupActions=true"), expect.any(Object));
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["identity_switch", "terminal_failure"])("does not report setup as opened after %s", async scenario => {
    let current = true;
    const create = vi.spyOn(useShellSessions.getState(), "create").mockResolvedValue(null);
    const get = vi.fn(async () => {
      if (scenario === "identity_switch") current = false;
      return { revision: "setup", drivers: [{ kind: "hermes", displayName: "Hermes", adapterVersion: "1.0.0", capabilityClass: "system_agent" }],
        instances: [{ id: "hermes_default", driverKind: "hermes", displayName: "Hermes", availability: "unavailable", unavailabilityReason: "disabled_in_settings",
          workspaceRequirement: "none", catalogRevision: "setup", models: [], options: [], skills: [], commands: [],
          setupActions: [{ id: "hermes_connect", kind: "foreground_terminal", label: "Connect Hermes", command: "server-issued-hermes-command" }],
          supports: { rootChat: true, resume: true, cancellation: true, attachments: [], tools: [], approvals: false, userInput: false,
            worktrees: "none", resources: [], interactionModes: [], permissionModes: [] } }] };
    });
    expect(await openDesktopProviderAgentSetup({ get } as never, "hermes", () => current)).toBe(false);
    if (scenario === "identity_switch") expect(create).not.toHaveBeenCalled();
    else expect(create).toHaveBeenCalledExactlyOnceWith({ get }, { cmd: "server-issued-hermes-command" });
  });
  it("opts Electron Settings into labels without losing bounded response and timeout", async () => {
    const api = { get: vi.fn(async () => ({ revision: "revision", drivers: [], instances: [] })) };
    expect(await openDesktopProviderAgentSetup(api as never, "pi", () => true)).toBe(false);
    expect(api.get).toHaveBeenCalledWith("/api/chat-providers?refresh=true&includeConnectionLabels=true&includeSettingsSetupActions=true",
      expect.objectContaining({ maxBytes: 1024 * 1024, signal: expect.any(AbortSignal), timeoutMs: 15_000 }));
    expect(api.get).toHaveBeenCalledOnce();
  });
});
