// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProviderSummary } from "@matrix-os/contracts";
import { ProviderReadinessNotice } from "../../desktop/src/renderer/src/features/coding-agents/ProviderReadinessNotice";
import type { ProviderReadinessPresentation } from "../../desktop/src/renderer/src/features/coding-agents/provider-readiness";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

const installAction = {
  id: "codex_install",
  kind: "foreground_terminal" as const,
  label: "Install Codex",
  command: "npm install -g @openai/codex",
};

const provider: AgentProviderSummary = {
  id: "codex",
  kind: "codex",
  displayName: "Codex",
  availability: "setup_required",
  installStatus: "missing",
  authStatus: "missing",
  supportedModes: ["default"],
  defaultMode: "default",
  setupActions: [installAction],
};

function readiness(
  overrides: Partial<ProviderReadinessPresentation> = {},
): ProviderReadinessPresentation {
  return {
    state: "missing",
    blocked: true,
    title: "Codex is not installed",
    description: "Install Codex before sending a message.",
    action: { kind: "setup", action: installAction },
    ...overrides,
  };
}

describe("ProviderReadinessNotice", () => {
  let api: { post: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    api = { post: vi.fn().mockResolvedValue({ name: "matrix-setup-codex" }) };
    useConnection.setState({ status: "signed-in", api: api as never });
    useTabs.setState(useTabs.getInitialState(), true);
    useUi.setState({ requestedSettingsSection: null });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders nothing when the selected provider is ready", () => {
    const { container } = render(
      <ProviderReadinessNotice
        readiness={readiness({
          state: "ready",
          blocked: false,
          title: "",
          description: "",
          action: null,
        })}
        providers={[provider]}
        onRefresh={vi.fn()}
      />,
    );

    expect(container.innerHTML).toBe("");
  });

  it.each([
    [
      "missing",
      "Codex is not installed",
      "Install Codex before sending a message.",
      "Install Codex",
    ],
    [
      "auth_required",
      "Connect Codex to continue",
      "Sign in to Codex before sending a message.",
      "Connect Codex",
    ],
  ] as const)("renders safe %s recovery copy", (state, title, description, label) => {
    const action = { ...installAction, id: `codex_${state}`, label };
    render(
      <ProviderReadinessNotice
        readiness={readiness({
          state,
          title,
          description,
          action: { kind: "setup", action },
        })}
        providers={[{ ...provider, setupActions: [action] }]}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(description)).toBeTruthy();
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/npm install|codex login|token|secret|\/home\//i);
  });

  it("requests Providers before opening Settings", () => {
    const order: string[] = [];
    const requestSettingsSection = vi.fn((section: string) => {
      order.push(`request:${section}`);
      useUi.setState({ requestedSettingsSection: section });
    });
    const openTab = vi.fn(() => {
      order.push("open:settings");
      return "settings";
    });
    useUi.setState({ requestSettingsSection });
    useTabs.setState({ openTab: openTab as never });

    render(
      <ProviderReadinessNotice
        readiness={readiness({
          state: "unconfigured",
          title: "No coding agent provider is configured",
          description: "Open provider settings to choose a coding agent provider.",
          action: {
            kind: "setup",
            action: {
              id: "provider_settings",
              kind: "open_settings",
              label: "Open provider settings",
            },
          },
        })}
        providers={[]}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open provider settings" }));

    expect(order).toEqual(["request:providers", "open:settings"]);
  });

  it("opens foreground setup in the canonical visible Terminal", async () => {
    render(
      <ProviderReadinessNotice
        readiness={readiness()}
        providers={[provider]}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install Codex" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/api/terminal/sessions",
      expect.objectContaining({ cmd: installAction.command, cwd: "projects" }),
    ));
    expect(useTabs.getState().tabs).toEqual([
      expect.objectContaining({ kind: "terminal", title: "Install Codex" }),
    ]);
  });

  it("refuses a renderer-supplied Claude action when the Gateway omits setup actions", async () => {
    const connectClaudeAction = {
      id: "claude_connect",
      kind: "foreground_terminal" as const,
      label: "Connect Claude",
      command: "claude",
    };
    const olderGatewayClaudeProvider: AgentProviderSummary = {
      ...provider,
      id: "claude",
      kind: "claude",
      displayName: "Claude",
      availability: "unavailable",
      installStatus: "unknown",
      authStatus: "unknown",
      setupActions: [],
    };

    render(
      <ProviderReadinessNotice
        readiness={readiness({
          state: "unverified",
          title: "Matrix could not verify Claude",
          description: "Refresh provider status or connect Claude before sending.",
          action: { kind: "setup", action: connectClaudeAction },
        })}
        providers={[olderGatewayClaudeProvider]}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));

    await waitFor(() => expect(screen.getByText(
      "Could not open provider setup. Open Providers settings to continue.",
    )).toBeTruthy());
    expect(api.post).not.toHaveBeenCalled();
    expect(useTabs.getState().tabs).toEqual([]);
  });

  it("rechecks provider readiness after opening a login terminal until the provider is ready", async () => {
    vi.useFakeTimers();
    const connectClaudeAction = {
      id: "claude_connect",
      kind: "foreground_terminal" as const,
      label: "Connect Claude",
      command: "claude",
    };
    const claudeProvider: AgentProviderSummary = {
      ...provider,
      id: "claude",
      kind: "claude",
      displayName: "Claude",
      availability: "auth_required",
      installStatus: "installed",
      authStatus: "missing",
      setupActions: [connectClaudeAction],
    };
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const blockedReadiness = readiness({
      state: "auth_required",
      title: "Connect Claude to continue",
      description: "Sign in to Claude before sending a message.",
      action: { kind: "setup", action: connectClaudeAction },
    });
    const { rerender } = render(
      <ProviderReadinessNotice
        readiness={blockedReadiness}
        providers={[claudeProvider]}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
    await act(async () => { await Promise.resolve(); });
    expect(api.post).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(
      <ProviderReadinessNotice
        readiness={readiness({
          state: "ready",
          blocked: false,
          title: "",
          description: "",
          action: null,
        })}
        providers={[{ ...claudeProvider, availability: "available", authStatus: "authenticated" }]}
        onRefresh={onRefresh}
      />,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("starts a fresh bounded recheck cycle after a later successful login launch", async () => {
    vi.useFakeTimers();
    const connectClaudeAction = {
      id: "claude_connect",
      kind: "foreground_terminal" as const,
      label: "Connect Claude",
      command: "claude",
    };
    const claudeProvider: AgentProviderSummary = {
      ...provider,
      id: "claude",
      kind: "claude",
      displayName: "Claude",
      availability: "auth_required",
      installStatus: "installed",
      authStatus: "missing",
      setupActions: [connectClaudeAction],
    };
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    render(
      <ProviderReadinessNotice
        readiness={readiness({
          state: "auth_required",
          title: "Connect Claude to continue",
          description: "Sign in to Claude before sending a message.",
          action: { kind: "setup", action: connectClaudeAction },
        })}
        providers={[claudeProvider]}
        onRefresh={onRefresh}
      />,
    );

    const connectButton = screen.getByRole("button", { name: "Connect Claude" });
    fireEvent.click(connectButton);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50 * 6_000); });
    expect(onRefresh).toHaveBeenCalledTimes(50);

    fireEvent.click(connectButton);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(onRefresh).toHaveBeenCalledTimes(51);
  });

  it("executes the current command in a fresh setup session on deliberate retry", async () => {
    render(
      <ProviderReadinessNotice
        readiness={readiness()}
        providers={[provider]}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install Codex" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const retryButton = screen.getByRole("button", { name: "Install Codex" });
    await waitFor(() => expect((retryButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(retryButton);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));

    const firstRequest = api.post.mock.calls[0]?.[1];
    const retryRequest = api.post.mock.calls[1]?.[1];
    expect(firstRequest).toEqual(expect.objectContaining({
      cmd: installAction.command,
      cwd: "projects",
      name: expect.stringMatching(/^matrix-setup-[a-z0-9-]{1,18}$/),
    }));
    expect(retryRequest).toEqual(expect.objectContaining({
      cmd: installAction.command,
      cwd: "projects",
      name: expect.stringMatching(/^matrix-setup-[a-z0-9-]{1,18}$/),
    }));
    expect(retryRequest.name).not.toBe(firstRequest.name);
  });

  it("refreshes once and exposes pending state", async () => {
    let finishRefresh: (() => void) | undefined;
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => {
      finishRefresh = resolve;
    }));
    render(
      <ProviderReadinessNotice
        readiness={readiness({
          state: "unverified",
          title: "Matrix could not verify Codex",
          description: "Refresh provider status before sending.",
          action: { kind: "refresh" },
        })}
        providers={[provider]}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh provider status" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Refreshing…")).toBeTruthy();

    await act(async () => finishRefresh?.());
    expect(screen.getByText("Refresh status")).toBeTruthy();
  });

  it("keeps manual status refresh available while authentication is required", async () => {
    const connectAction = {
      ...installAction,
      id: "codex_auth_required",
      label: "Connect Codex",
      command: "codex login --device-auth",
    };
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(
      <ProviderReadinessNotice
        readiness={readiness({
          state: "auth_required",
          title: "Connect Codex to continue",
          description: "Sign in to Codex before sending a message.",
          action: { kind: "setup", action: connectAction },
        })}
        providers={[{ ...provider, setupActions: [connectAction] }]}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByRole("button", { name: "Connect Codex" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh provider status" }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Connect Codex" })).toBeTruthy();
  });

  it("fails safely without an API while keeping the recovery notice visible", async () => {
    useConnection.setState({ api: null });
    render(
      <ProviderReadinessNotice
        readiness={readiness()}
        providers={[provider]}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install Codex" }));

    expect(await screen.findByText("Could not open provider setup. Open Providers settings to continue.")).toBeTruthy();
    expect(screen.getByText("Codex is not installed")).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });
});
