// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { deriveCanonicalProviderChoices } from "../../packages/ui/src/canonical-provider-choice.js";
import { ChatProviderSetupPanel } from "../../shell/src/components/chat-app-provider-setup.js";

afterEach(cleanup);

function catalog(available: boolean, discoverUnavailableModel = false) {
  return CanonicalProviderCatalogSchema.parse({
    revision: "reserved-matrix-pi",
    drivers: [{ kind: "matrix_pi", displayName: "Matrix Pi", adapterVersion: "1.0.0", capabilityClass: "system_agent" }],
    instances: [{
      id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Matrix Pi",
      ...(available ? { connectionLabel: "Matrix AI", connectionState: "ready" } : {}),
      availability: available ? "available" : "unavailable", workspaceRequirement: "none",
      catalogRevision: "reserved-matrix-pi",
      models: available || discoverUnavailableModel ? [{ id: "matrix-model", displayName: "Matrix model", availability: available ? "available" : "unavailable",
        capabilities: ["tools"], supportsVision: false, supportsToolUse: true }] : [],
      options: [], skills: [], commands: [], setupActions: [],
      supports: { rootChat: true, resume: false, cancellation: true, attachments: [], tools: [],
        approvals: false, userInput: false, worktrees: "none", resources: [],
        interactionModes: ["default"], permissionModes: ["supervised"] },
      ...(available ? { defaultSelection: { instanceId: "matrix_pi_default", model: "matrix-model" } } : {}),
    }],
  });
}

function panel(available: boolean, discoverUnavailableModel = false) {
  const value = catalog(available, discoverUnavailableModel);
  const choices = deriveCanonicalProviderChoices(value);
  const onSelect = vi.fn();
  const rendered = render(<ChatProviderSetupPanel catalog={value} choices={choices} selected={choices[0] ?? null}
    onSelect={onSelect} onInteractionModeChange={vi.fn()} onPermissionModeChange={vi.fn()}
    onOptionChange={vi.fn()} onSetupAction={vi.fn()} showChannels={false} channels={new Set()}
    onToggleChannel={vi.fn()} onDismiss={vi.fn()} />);
  return { ...rendered, onSelect, choices };
}

describe("reserved general Matrix AI Chat artwork", () => {
  it("renders a ready Matrix AI route with Matrix artwork and selects its exact server choice", () => {
    const { onSelect, choices } = panel(true);
    expect(screen.getByRole("group", { name: "General agents" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Matrix AI agent, Available" })).toHaveAttribute("data-availability", "available");
    const option = screen.getByRole("option", { name: "Matrix model via Matrix AI" });
    expect(option).toBeEnabled();
    expect(option.querySelector("svg.matrix-chat-rabbit-mark")).not.toBeNull();
    expect(option.querySelector(".matrix-ap-agent-logo")).toBeNull();
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith(choices[0]);
    expect(onSelect.mock.calls[0]![0]).toMatchObject({ driverKind: "matrix_pi", instanceId: "matrix_pi_default", modelId: "matrix-model" });
  });

  it("renders an unavailable reserved route without requiring connection labels or enabling selection", () => {
    const { onSelect, choices } = panel(false);
    const agent = screen.getByRole("button", { name: "Matrix AI agent, Unavailable" });
    expect(agent).toHaveAttribute("data-availability", "unavailable");
    expect(agent.querySelector("svg.matrix-chat-rabbit-mark")).not.toBeNull();
    expect(agent).toBeEnabled();
    expect(screen.queryByRole("option")).toBeNull();
    expect(choices).toEqual([]);
    fireEvent.click(agent);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps discovered unavailable models disabled while showing Matrix artwork", () => {
    const { onSelect, choices } = panel(false, true);
    const option = screen.getByRole("option", { name: "Matrix model via Matrix AI" });
    expect(option.querySelector("svg.matrix-chat-rabbit-mark")).not.toBeNull();
    expect(option).toBeDisabled();
    expect(choices).toEqual([]);
    fireEvent.click(option);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
