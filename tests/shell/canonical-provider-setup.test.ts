// @vitest-environment jsdom

import { CanonicalProviderInstanceDescriptorSchema } from "@matrix-os/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeCanonicalProviderSetupAction,
  OPEN_PROVIDER_SETTINGS_EVENT,
  OPEN_PROVIDER_TERMINAL_EVENT,
  providerTerminalSessionFromEvent,
} from "../../shell/src/lib/canonical-provider-setup.js";

function instance() {
  return CanonicalProviderInstanceDescriptorSchema.parse({
    id: "opencode_default",
    driverKind: "opencode",
    displayName: "OpenCode",
    availability: "setup_required",
    workspaceRequirement: "project_optional",
    catalogRevision: "catalog_setup",
    models: [], options: [], skills: [], commands: [],
    setupActions: [{
      id: "opencode_connect",
      kind: "foreground_terminal",
      label: "Connect OpenCode",
      command: "sh -lc 'opencode'",
    }, {
      id: "opencode_settings",
      kind: "open_settings",
      label: "Configure OpenCode",
    }],
    supports: {
      rootChat: true, resume: true, cancellation: true, attachments: [], tools: [],
      approvals: false, userInput: false, worktrees: "optional", resources: [],
      interactionModes: [], permissionModes: [],
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("shared shell canonical Provider setup", () => {
  it("creates a visible canonical Terminal session and emits only its validated id", async () => {
    const provider = instance();
    const terminalEvents: Event[] = [];
    window.addEventListener(OPEN_PROVIDER_TERMINAL_EVENT, (event) => terminalEvents.push(event), { once: true });
    const fetcher = vi.fn(async () => Response.json({ name: "matrix-setup-opencode" }, { status: 201 }));

    await expect(executeCanonicalProviderSetupAction({
      instance: provider,
      action: provider.setupActions[0]!,
      fetcher,
    })).resolves.toBe(true);

    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/api/terminal/sessions"), expect.objectContaining({
      method: "POST",
      body: expect.stringContaining("sh -lc 'opencode'"),
      signal: expect.any(AbortSignal),
    }));
    expect(providerTerminalSessionFromEvent(terminalEvents[0]!)).toBe("matrix-setup-opencode");
  });

  it("opens Agents & providers without accepting an action outside the catalog instance", async () => {
    const provider = instance();
    const opened = vi.fn();
    window.addEventListener(OPEN_PROVIDER_SETTINGS_EVENT, opened, { once: true });

    await expect(executeCanonicalProviderSetupAction({
      instance: provider,
      action: provider.setupActions[1]!,
    })).resolves.toBe(true);
    expect(opened).toHaveBeenCalledOnce();

    await expect(executeCanonicalProviderSetupAction({
      instance: provider,
      action: { ...provider.setupActions[0]!, command: "malicious" },
      fetcher: vi.fn(),
    })).resolves.toBe(false);
  });
});
