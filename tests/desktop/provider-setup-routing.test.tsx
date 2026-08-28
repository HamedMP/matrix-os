// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CanonicalProviderDriverKind,
  CanonicalProviderInstanceDescriptor,
} from "@matrix-os/contracts";
import { useProviderSetup } from "../../desktop/src/renderer/src/features/chat/use-provider-setup";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

function instance(driverKind: CanonicalProviderDriverKind): CanonicalProviderInstanceDescriptor {
  return {
    id: `${driverKind}_default`,
    driverKind,
    displayName: driverKind === "openclaw" ? "OpenClaw" : "Hermes",
    availability: "unavailable",
    workspaceRequirement: "none",
    catalogRevision: "catalog_test",
    models: [],
    options: [],
    skills: [],
    commands: [],
    setupActions: [{
      id: `${driverKind}_settings`,
      kind: "open_settings",
      label: `Configure ${driverKind === "openclaw" ? "OpenClaw" : "Hermes"}`,
    }],
    supports: {
      rootChat: true,
      resume: true,
      cancellation: true,
      attachments: [],
      tools: [],
      approvals: false,
      userInput: false,
      worktrees: "none",
      resources: [],
      interactionModes: ["default"],
      permissionModes: ["supervised"],
    },
  };
}

function Harness({ driverKind }: { driverKind: "hermes" | "openclaw" }) {
  const provider = instance(driverKind);
  const setup = useProviderSetup([]);
  return (
    <button type="button" onClick={() => void setup(provider, provider.setupActions[0]!)}>
      Configure
    </button>
  );
}

function TerminalHarness({ api }: { api: ApiClient }) {
  const provider: CanonicalProviderInstanceDescriptor = {
    ...instance("hermes"),
    id: "opencode_default",
    driverKind: "opencode",
    displayName: "OpenCode",
    availability: "setup_required",
    workspaceRequirement: "project_optional",
    setupActions: [{
      id: "opencode_connect",
      kind: "foreground_terminal",
      label: "Connect OpenCode",
      command: "sh -lc 'opencode'",
    }],
  };
  const setup = useProviderSetup([], undefined, api);
  return (
    <button type="button" onClick={() => void setup(provider, provider.setupActions[0]!)}>
      Connect
    </button>
  );
}

describe("system harness setup routing", () => {
  beforeEach(() => {
    useTabs.setState(useTabs.getInitialState(), true);
    useUi.setState({ requestedSettingsSection: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each(["hermes", "openclaw"] as const)("routes %s configuration to Agent settings", (driverKind) => {
    render(<Harness driverKind={driverKind} />);

    fireEvent.click(screen.getByRole("button", { name: "Configure" }));

    expect(useUi.getState().requestedSettingsSection).toBe("agent");
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "settings")).toBe(true);
  });

  it("opens a catalog-owned missing harness action in a foreground Terminal", async () => {
    const post = vi.fn(async () => ({ name: "matrix-setup-opencode" }));
    render(<TerminalHarness api={{ post } as unknown as ApiClient} />);

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/terminal/sessions", expect.objectContaining({
      cwd: "projects",
      cmd: "sh -lc 'opencode'",
    })));
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "terminals")).toBe(true);
    expect(useTabs.getState().terminalSessionRequest?.sessionName).toBe("matrix-setup-opencode");
  });
});
