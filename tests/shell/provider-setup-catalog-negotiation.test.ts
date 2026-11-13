// @vitest-environment jsdom
import { FUNDED_AI_READINESS_TIMEOUTS } from "@matrix-os/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubDeveloperDisconnectCommand } from "../../packages/ui/src/integrations/GithubDeveloperAccess.js";
import { openWebProviderAgentSetup, openWebProviderTerminalCommand } from "../../shell/src/lib/provider-settings-transport.js";
import { useShellSessions } from "../../desktop/src/renderer/src/stores/shell-sessions";
import { openDesktopGithubDeveloperDisconnect, openDesktopProviderAgentSetup } from "../../desktop/src/renderer/src/features/settings/provider-settings-desktop-adapter.js";

describe("Settings catalog connection-label negotiation", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("dispatches the GitHub account-bound disconnect argv through the Web Terminal once", async () => {
    const workspaceId = `tws_${"a".repeat(32)}`;
    const tabId = `tt_${"b".repeat(32)}`;
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ workspace: { id: workspaceId } }))
      .mockResolvedValueOnce(Response.json({ tab: { id: tabId } }));
    vi.stubGlobal("fetch", fetcher);
    const open = vi.fn();
    const command = githubDeveloperDisconnectCommand("octocat")!;
    await expect(openWebProviderTerminalCommand(command, "disconnect-github", open, () => true)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toMatch(new RegExp(`/api/terminal/workspaces/${workspaceId}/tabs$`));
    expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toMatchObject({ command });
    expect(open).toHaveBeenCalledExactlyOnceWith(`${workspaceId}:${tabId}`);
  });
  it("fences the Electron disconnect mutation between workspace ensure and tab creation", async () => {
    let current = true;
    const post = vi.fn(async () => {
      current = false;
      return { workspace: { id: `tws_${"a".repeat(32)}` } };
    });
    await expect(openDesktopGithubDeveloperDisconnect({ post } as never, "octocat", () => current,
      new AbortController().signal)).resolves.toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("opts Web Settings into labels while requesting a fresh catalog", async () => {
    const fetcher = vi.fn(async () => Response.json({ revision: "revision", drivers: [], instances: [] }));
    vi.stubGlobal("fetch", fetcher);
    expect(await openWebProviderAgentSetup("pi", vi.fn())).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/api/chat-providers?refresh=true&includeConnectionLabels=true&includeConnectionState=true&includeFundingState=true&includeChatFunding=true&includeObservationState=true&includeLivePermissionModes=true"), expect.any(Object));
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
    expect(api.get).toHaveBeenCalledWith("/api/chat-providers?refresh=true&includeConnectionLabels=true&includeConnectionState=true&includeFundingState=true&includeChatFunding=true&includeObservationState=true&includeLivePermissionModes=true&includeSettingsSetupActions=true",
      expect.objectContaining({ maxBytes: 1024 * 1024, signal: expect.any(AbortSignal), timeoutMs: FUNDED_AI_READINESS_TIMEOUTS.rendererRequestMs }));
    expect(api.get).toHaveBeenCalledOnce();
  });
});
