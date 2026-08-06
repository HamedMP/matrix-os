// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HermesConfigurationDialog } from "../../desktop/src/renderer/src/features/settings/hermes/HermesConfigurationDialog";

const configuration = {
  config: {
    general: { model: "anthropic/claude-sonnet-4.6", quiet: false },
    delegation: { tools: ["codex"] },
  },
  defaults: {
    general: { model: "", quiet: true },
    delegation: { tools: [] },
  },
  fields: {
    "general.model": { type: "string", description: "Default model", category: "general" },
    "general.quiet": { type: "boolean", description: "Quiet mode", category: "general" },
    "delegation.tools": { type: "list", description: "Delegation tools", category: "delegation" },
  },
  categoryOrder: ["general", "delegation"],
};

const environment = {
  OPENAI_API_KEY: {
    is_set: false,
    description: "OpenAI API key",
    category: "Providers",
    is_password: true,
    tools: ["hermes"],
    advanced: false,
    channel_managed: false,
    provider: "openai",
    provider_label: "OpenAI",
  },
  ANTHROPIC_API_KEY: {
    is_set: true,
    redacted_value: "sk-ant-...1234",
    description: "Anthropic API key",
    category: "Providers",
    is_password: true,
    tools: ["hermes"],
    advanced: false,
    channel_managed: false,
    provider: "anthropic",
    provider_label: "Anthropic",
  },
};

function renderDialog(props: Partial<React.ComponentProps<typeof HermesConfigurationDialog>> = {}) {
  const onClose = vi.fn();
  const onOpenSetupTerminal = vi.fn().mockResolvedValue(undefined);
  const onConfigurationChanged = vi.fn();
  render(<HermesConfigurationDialog
    open
    version="0.20.0"
    onClose={onClose}
    onOpenSetupTerminal={onOpenSetupTerminal}
    onConfigurationChanged={onConfigurationChanged}
    {...props}
  />);
  return { onClose, onOpenSetupTerminal, onConfigurationChanged };
}

describe("Desktop Hermes configuration dialog", () => {
  beforeEach(() => {
    window.operator = {
      invoke: vi.fn((channel: string) => {
        if (channel === "runtime:get-hermes-configuration") return Promise.resolve(configuration);
        if (channel === "runtime:get-hermes-environment") return Promise.resolve(environment);
        return Promise.resolve({ ok: true });
      }),
      on: vi.fn(() => () => undefined),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads settings and credential metadata in parallel into a Desktop-themed modal", async () => {
    renderDialog();

    expect(screen.getByText("Loading Hermes configuration…")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Configure Hermes" })).toBeTruthy();
    expect(screen.getByText("Version 0.20.0")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Credentials" })).toBeTruthy();
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-hermes-configuration", {});
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-hermes-environment", {});
  });

  it("edits, discards, validates, and saves dynamic settings", async () => {
    const { onConfigurationChanged } = renderDialog();
    const model = await screen.findByLabelText("Default model") as HTMLInputElement;

    fireEvent.change(model, { target: { value: "openai/gpt-5" } });
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard Hermes changes" }));
    expect(model.value).toBe("anthropic/claude-sonnet-4.6");

    fireEvent.click(screen.getByRole("button", { name: "Delegation" }));
    const list = screen.getByLabelText("Delegation tools") as HTMLTextAreaElement;
    fireEvent.change(list, { target: { value: '[{"not":"allowed"}]' } });
    expect(screen.getByRole("alert").textContent).toContain("Enter a JSON list of strings, numbers, or booleans.");
    expect((screen.getByRole("button", { name: "Save Hermes settings" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(list, { target: { value: '["codex", "claude"]' } });
    fireEvent.click(screen.getByRole("button", { name: "Save Hermes settings" }));
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith(
      "runtime:update-hermes-configuration",
      { changes: [{ path: "delegation.tools", value: ["codex", "claude"] }] },
    ));
    expect(onConfigurationChanged).toHaveBeenCalled();
  });

  it("sets and removes write-only credentials without rendering their values", async () => {
    renderDialog();
    await screen.findByRole("heading", { name: "Configure Hermes" });
    fireEvent.click(screen.getByRole("tab", { name: "Credentials" }));

    const key = screen.getByLabelText("OPENAI_API_KEY value") as HTMLInputElement;
    fireEvent.change(key, { target: { value: "sk-write-only" } });
    fireEvent.click(screen.getByRole("button", { name: "Save OPENAI_API_KEY" }));
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith(
      "runtime:set-hermes-credential",
      { key: "OPENAI_API_KEY", value: "sk-write-only" },
    ));
    expect(key.value).toBe("");
    expect(screen.queryByDisplayValue("sk-write-only")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove ANTHROPIC_API_KEY" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove ANTHROPIC_API_KEY" }));
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith(
      "runtime:remove-hermes-credential",
      { key: "ANTHROPIC_API_KEY" },
    ));
  });

  it("keeps failures generic and exposes the explicit terminal fallback", async () => {
    vi.mocked(window.operator.invoke).mockRejectedValueOnce(
      new Error("connect ECONNREFUSED /home/matrix secret-token"),
    );
    const { onOpenSetupTerminal } = renderDialog();

    expect((await screen.findByRole("alert")).textContent).toContain("Hermes configuration is unavailable.");
    expect(screen.queryByText(/ECONNREFUSED|\/home\/matrix|secret-token/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open setup terminal" }));
    expect(onOpenSetupTerminal).toHaveBeenCalled();
  });
});
