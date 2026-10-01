// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => { cleanup(); vi.useRealTimers(); });

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
  it("shows Matrix AI at the top level and selects its actual Pi execution route", () => {
    const select = vi.fn();
    const managed = { ...pi, modelId: "cloudflare:@cf/zai-org/glm-5.3-flash", modelLabel: "GLM Flash", connectionLabel: "Matrix AI" };
    const managedCatalog = { ...catalog, instances: catalog.instances.filter(instance => instance.driverKind !== "kernel")
      .map(instance => instance.id === pi.instanceId ? { ...instance, connectionLabel: "Matrix AI", models: [{ ...instance.models[0]!, id: managed.modelId, displayName: managed.modelLabel }] } : instance) };
    render(<CompactChatProviderChoices catalog={managedCatalog} choices={[managed]} selected={managed} onSelect={select}
      renderDriverIcon={kind => <span data-testid={`glyph-${kind}`} />} />);
    const entry = screen.getByRole("button", { name: "Matrix AI agent, Available" });
    expect(entry).toBeVisible();
    expect(within(entry).getByTestId("glyph-kernel")).toBeVisible();
    fireEvent.click(entry);
    fireEvent.click(screen.getByRole("option", { name: "GLM Flash via Pi · Work · Matrix AI" }));
    expect(select).toHaveBeenCalledWith(managed);
    expect(select.mock.calls[0]![0].instanceId).toBe("pi_work");
  });
  it("keeps an unavailable Matrix AI entry browsable without inventing a selectable route", () => {
    const select = vi.fn();
    const ownCatalog = { ...catalog, instances: catalog.instances.filter(instance => instance.driverKind !== "kernel") };
    render(<CompactChatProviderChoices catalog={ownCatalog} choices={[pi]} selected={pi} onSelect={select} />);
    const entry = screen.getByRole("button", { name: "Matrix AI agent, Unavailable" });
    expect(entry).toBeEnabled();
    fireEvent.click(entry);
    expect(screen.getByText("Matrix AI is unavailable on this computer.")).toBeVisible();
    expect(screen.queryByRole("option")).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });
  it("shows the server's managed credit state without offering an unavailable model", () => {
    const funded = { ...catalog.instances[1]!, connectionLabel: "Matrix AI", connectionState: "credit_required" as const,
      availability: "unavailable" as const, models: [], defaultSelection: undefined };
    render(<CompactChatProviderChoices catalog={{ ...catalog, instances: [funded] }} choices={[]} selected={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Matrix AI agent, Matrix AI credit required" }));
    expect(screen.getByText("Matrix AI credit required")).toBeVisible();
    expect(screen.queryByRole("option")).toBeNull();
  });
  it("keeps resumed chats locked to the underlying managed instance", () => {
    const select = vi.fn();
    const managed = { ...pi, connectionLabel: "Matrix AI" };
    const managedCatalog = { ...catalog, instances: catalog.instances.map(instance => instance.id === pi.instanceId
      ? { ...instance, connectionLabel: "Matrix AI" } : instance) };
    render(<CompactChatProviderChoices catalog={managedCatalog} choices={[managed, matrix]} selected={managed}
      lockedInstanceId={pi.instanceId} onSelect={select} />);
    fireEvent.click(screen.getByRole("button", { name: "Matrix AI agent, Available" }));
    expect(screen.getByRole("option", { name: "Claude Sonnet 5 via Matrix AI" })).toBeDisabled();
    fireEvent.click(screen.getByRole("option", { name: "Claude Sonnet 5 via Pi · Work · Matrix AI" }));
    expect(select).toHaveBeenCalledWith(managed);
  });
  it("keeps a locally configured Codex choice selectable with qualified copy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T00:00:00.000Z"));
    const codex: CanonicalProviderChoice = {
      ...pi, instanceId: "codex_default", driverKind: "codex", harnessLabel: "Codex",
      modelId: "gpt-5.4", modelLabel: "GPT-5.4",
    };
    const codexCatalog: CanonicalProviderCatalog = {
      ...catalog,
      drivers: [...catalog.drivers, { kind: "codex", displayName: "Codex", adapterVersion: "1", capabilityClass: "coding_agent" }],
      instances: [...catalog.instances, {
        ...catalog.instances[1]!, id: "codex_default", driverKind: "codex", displayName: "Codex",
        localObservation: { state: "present_unverified", checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 5_000).toISOString() },
        models: [{ ...catalog.instances[1]!.models[0]!, id: "gpt-5.4", displayName: "GPT-5.4" }],
      }],
    };
    const select = vi.fn();
    render(<CompactChatProviderChoices catalog={codexCatalog} choices={[codex]} selected={codex} onSelect={select} />);
    expect(screen.getByRole("button", { name: "Codex agent, Local login found; access not verified" })).toBeVisible();
    const option = screen.getByRole("option", { name: "GPT-5.4 via Codex" });
    expect(within(option).getByText(/Local login found; access not verified/)).toBeVisible();
    act(() => vi.advanceTimersByTime(5_001));
    expect(screen.getByRole("button", { name: "Codex agent, Local login last found; access not verified" })).toBeVisible();
    fireEvent.click(option);
    expect(select).toHaveBeenCalledWith(codex);
  });
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

  it("lets owners inspect a saved-off system harness without offering connection or model selection", () => {
    const select = vi.fn();
    const setup = vi.fn();
    const disabledHermes = {
      ...catalog.instances[1]!, id: "hermes_default", driverKind: "hermes" as const,
      displayName: "Hermes", availability: "unavailable" as const,
      unavailabilityReason: "disabled_in_settings" as const,
      models: [], setupActions: [],
    };
    const systemCatalog: CanonicalProviderCatalog = {
      ...catalog,
      drivers: [...catalog.drivers, {
        kind: "hermes", displayName: "Hermes", adapterVersion: "1", capabilityClass: "system_agent",
      }],
      instances: [...catalog.instances, disabledHermes],
    };
    render(<CompactChatProviderChoices catalog={systemCatalog} choices={[matrix, pi]} selected={pi}
      onSelect={select} onSetupAction={setup} />);

    const button = screen.getByRole("button", { name: "Hermes agent, Disabled in Settings" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Disabled in Settings")).toBeVisible();
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect Hermes" })).toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
  });

  it.each([
    ["openclaw", "OpenClaw", "system_agent"],
    ["pi", "Pi", "coding_agent"],
    ["opencode", "OpenCode", "coding_agent"],
  ] as const)("shows saved-off %s without setup or selectable models", (kind, name, capabilityClass) => {
    const select = vi.fn();
    const setup = vi.fn();
    const disabledInstance = {
      ...catalog.instances[1]!, id: `${kind}_default`, driverKind: kind,
      displayName: name, availability: "unavailable" as const,
      unavailabilityReason: "disabled_in_settings" as const,
      models: [], setupActions: [], defaultSelection: undefined,
    };
    const disabledCatalog: CanonicalProviderCatalog = {
      ...catalog,
      drivers: [{ kind, displayName: name, adapterVersion: "1", capabilityClass }],
      instances: [disabledInstance],
    };
    render(<CompactChatProviderChoices catalog={disabledCatalog} choices={[]} selected={null}
      onSelect={select} onSetupAction={setup} />);

    const button = screen.getByRole("button", { name: `${name} agent, Disabled in Settings` });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(screen.getByText("Disabled in Settings")).toBeVisible();
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.queryByRole("button", { name: `Connect ${name}` })).toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
  });
});


describe("provider setup affordances", () => {
  function installPickerStyles() {
    const style = document.createElement("style");
    style.textContent = `:root { --accent: rgb(20, 60, 40); --text-on-accent: rgb(250, 250, 245); }
${readFileSync("packages/ui/src/compact-chat-provider-choices.css", "utf8")}`;
    document.head.append(style);
    return () => style.remove();
  }

  it.each(["claude_code", "codex"] as const)("keeps unauthenticated %s colorful and its existing connection action prominent with another provider selected", (driverKind) => {
    const removeStyles = installPickerStyles();
    try {
      const label = driverKind === "claude_code" ? "Claude Code" : "Codex";
      const action = { id: "connect", kind: "open_settings" as const, label: `Connect ${driverKind === "claude_code" ? "Claude" : "Codex"}` };
      const instance = { ...catalog.instances[2]!, id: `${driverKind}_default`, driverKind, displayName: label, setupActions: [action] };
      const setup = vi.fn();
      const select = vi.fn();
      render(<CompactChatProviderChoices catalog={{ ...catalog, drivers: [...catalog.drivers, { kind: driverKind, displayName: label, adapterVersion: "1", capabilityClass: "coding_agent" }], instances: [...catalog.instances, instance] }}
        choices={[matrix, pi]} selected={pi} onSelect={select} onSetupAction={setup} />);
      const entry = screen.getByRole("button", { name: `${label} agent, Authentication required` });
      expect(entry).toBeEnabled();
      expect(Number(getComputedStyle(entry).opacity || "1")).toBe(1);
      fireEvent.click(entry);
      expect(entry).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("option")).toBeNull();
      const connect = screen.getByRole("button", { name: action.label });
      const appearance = getComputedStyle(connect);
      expect(appearance.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(appearance.borderStyle).toBe("solid");
      expect(appearance.justifyContent).toBe("center");
      fireEvent.click(connect);
      expect(setup).toHaveBeenCalledExactlyOnceWith(instance, action);
      expect(select).not.toHaveBeenCalled();
    } finally { removeStyles(); }
  });

  it("retains dimmed and disabled semantics for a locked ready provider", () => {
    const removeStyles = installPickerStyles();
    try {
      const select = vi.fn();
      render(<CompactChatProviderChoices catalog={{ ...catalog, instances: catalog.instances.map(instance => instance.driverKind === "opencode" ? { ...instance, availability: "available", setupActions: [] } : instance) }} choices={[matrix, pi]} selected={pi}
        lockedInstanceId={pi.instanceId} onSelect={select} />);
      const locked = screen.getByRole("button", { name: "OpenCode agent, Available" });
      expect(locked).toBeDisabled();
      expect(Number(getComputedStyle(locked).opacity)).toBeLessThan(1);
      fireEvent.click(locked);
      expect(select).not.toHaveBeenCalled();
    } finally { removeStyles(); }
  });
});
