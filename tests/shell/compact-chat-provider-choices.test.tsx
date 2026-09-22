// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { CompactChatProviderChoices } from "../../packages/ui/src/compact-chat-provider-choices.js";
import type { CanonicalProviderChoice } from "../../packages/ui/src/canonical-provider-choice.js";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";

const matrix: CanonicalProviderChoice = {
  instanceId: "kernel_matrix_included", driverKind: "kernel", harnessLabel: "Matrix AI",
  modelId: "claude-sonnet-5", modelLabel: "Claude Sonnet 5", interactionMode: "default",
  interactionModes: ["default"], permissionMode: "supervised", permissionModes: ["supervised"],
  options: [], selectedOptions: [], supportsFileAttachments: true,
};
const pi = { ...matrix, instanceId: "pi_work", driverKind: "pi" as const, harnessLabel: "Pi · Work" };

const support = {
  rootChat: true, resume: true, cancellation: true, attachments: ["file"] as const,
  tools: [], approvals: false, userInput: false, worktrees: "optional" as const,
  resources: ["file"] as const, interactionModes: ["default"], permissionModes: ["supervised"],
};
const catalog: CanonicalProviderCatalog = {
  revision: "two-pane-fixture",
  drivers: [
    { kind: "kernel", displayName: "Matrix AI", adapterVersion: "1", capabilityClass: "system_agent" },
    { kind: "pi", displayName: "Pi", adapterVersion: "1", capabilityClass: "coding_agent" },
    { kind: "opencode", displayName: "OpenCode", adapterVersion: "1", capabilityClass: "coding_agent" },
  ],
  instances: [
    {
      id: matrix.instanceId, driverKind: "kernel", displayName: matrix.harnessLabel,
      availability: "available", workspaceRequirement: "none", catalogRevision: "two-pane-fixture",
      models: [{ id: matrix.modelId, displayName: matrix.modelLabel, availability: "available", capabilities: [], supportsVision: false, supportsToolUse: true }],
      options: [], skills: [], commands: [], setupActions: [], supports: support,
    },
    {
      id: pi.instanceId, driverKind: "pi", displayName: pi.harnessLabel,
      availability: "available", workspaceRequirement: "project_optional", catalogRevision: "two-pane-fixture",
      models: [{ id: pi.modelId, displayName: pi.modelLabel, availability: "available", capabilities: [], supportsVision: false, supportsToolUse: true }],
      options: [], skills: [], commands: [], setupActions: [], supports: support,
    },
    {
      id: "opencode_default", driverKind: "opencode", displayName: "OpenCode",
      availability: "auth_required", unavailabilityReason: "authentication_required",
      workspaceRequirement: "project_optional", catalogRevision: "two-pane-fixture",
      models: [], options: [], skills: [], commands: [],
      setupActions: [{ id: "connect", kind: "open_settings", label: "Connect OpenCode" }], supports: support,
    },
  ],
};

describe("compact shared Chat choices", () => {
  it("ships scoped picker colors for both Electron and Web themes", () => {
    render(<CompactChatProviderChoices choices={[matrix]} selected={matrix} onSelect={vi.fn()} />);
    expect(screen.getByRole("searchbox")).toHaveClass("matrix-chat-model-search");
    expect(screen.getByRole("option")).toHaveClass("matrix-chat-model-option");
    const css = readFileSync("packages/ui/src/compact-chat-provider-choices.css", "utf8");
    expect(css).toContain("var(--border-default, var(--border))");
    expect(css).toContain("var(--text-tertiary, var(--muted-foreground))");
    expect(css).toContain("var(--bg-hover, var(--muted))");
    expect(css).toContain(".matrix-chat-model-option:hover:not(:disabled)");
    expect(css).toContain(".matrix-chat-model-option:focus-visible");
  });
  it("shows and searches Pi's server-projected Matrix connection without changing the agent", () => {
    const select = vi.fn();
    const fundedPi = { ...pi, connectionLabel: "Matrix AI" };
    render(<CompactChatProviderChoices choices={[fundedPi]} selected={fundedPi} onSelect={select} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "matrix" } });
    fireEvent.click(screen.getByRole("option", { name: "Claude Sonnet 5 via Pi · Work · Matrix AI" }));
    expect(select).toHaveBeenCalledWith(fundedPi);
  });
  it("searches Matrix AI and preserves exact account instance/model selection", () => {
    const select = vi.fn();
    render(<CompactChatProviderChoices choices={[pi, matrix]} selected={pi} onSelect={select} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "matrix" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("option", { name: "Claude Sonnet 5 via Matrix AI" }));
    expect(select).toHaveBeenCalledWith(matrix);
    expect(screen.getByRole("listbox")).toHaveStyle({ maxHeight: "240px", overflowY: "auto" });
  });
  it("keeps another instance locked, including keyboard selection", () => {
    const select = vi.fn();
    render(<CompactChatProviderChoices choices={[pi, matrix]} selected={pi} lockedInstanceId={pi.instanceId} onSelect={select} />);
    expect(screen.getByRole("option", { name: /via Matrix AI/ })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /via Pi/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("option", { name: /via Matrix AI/ }));
    expect(select).not.toHaveBeenCalled();
  });

  it("restores grouped provider navigation with models and setup in a separate pane", () => {
    const select = vi.fn();
    const setup = vi.fn();
    render(<CompactChatProviderChoices catalog={catalog} choices={[matrix, pi]} selected={pi}
      onSelect={select} onSetupAction={setup}
      renderDriverIcon={(kind) => <span>{kind}</span>} />);

    expect(screen.getByRole("group", { name: "General agents" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Coding agents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pi · Work agent, Available" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("option", { name: "Claude Sonnet 5 via Pi · Work" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Claude Sonnet 5 via Matrix AI" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Matrix AI agent, Available" }));
    expect(screen.getByRole("option", { name: "Claude Sonnet 5 via Matrix AI" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "OpenCode agent, Authentication required" }));
    expect(screen.getByText("Authentication required")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect OpenCode" }));
    expect(setup).toHaveBeenCalledWith(catalog.instances[2], catalog.instances[2]?.setupActions[0]);
  });
});
