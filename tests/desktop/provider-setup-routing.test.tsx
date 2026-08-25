// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CanonicalProviderDriverKind,
  CanonicalProviderInstanceDescriptor,
} from "@matrix-os/contracts";
import { useProviderSetup } from "../../desktop/src/renderer/src/features/chat/use-provider-setup";
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
});
