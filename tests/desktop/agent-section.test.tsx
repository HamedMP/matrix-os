// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentSection from "../../desktop/src/renderer/src/features/settings/sections/AgentSection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

describe("AgentSection", () => {
  let api: {
    get: ReturnType<typeof vi.fn>;
    getText: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    putText: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    api = {
      get: vi.fn((path: string) => {
        if (path === "/api/settings/agent") {
          return Promise.resolve({
            kernel: { model: null, effort: null },
            availableModels: [
              { id: "sonnet", label: "Sonnet", tier: "Balanced" },
              { id: "opus", label: "Opus", tier: "Deep" },
            ],
            availableEfforts: ["medium"],
            defaults: { model: "sonnet", effort: "medium" },
          });
        }
        if (path === "/api/agents/credentials/status") {
          return Promise.resolve({});
        }
        return Promise.reject(new Error(`unexpected path ${path}`));
      }),
      getText: vi.fn().mockResolvedValue("# SOUL"),
      post: vi.fn(),
      put: vi.fn().mockResolvedValue({ ok: true }),
      putText: vi.fn(),
    };
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: api as never,
    });
    useTabs.setState({
      activeTabId: "agents",
      tabs: [{ id: "agents", kind: "agents", title: "Agents" }],
    });
    window.operator = {
      invoke: vi.fn((channel: string) => {
        if (channel === "runtime:get-summary") {
          return Promise.resolve({
            runtime: { id: "rt_primary", label: "Primary", status: "available" },
            capabilities: [{ id: "codingAgentsRuntimeSummary", enabled: true }],
            providers: [
              {
                id: "codex",
                kind: "codex",
                displayName: "Codex",
                availability: "auth_required",
                installStatus: "installed",
                authStatus: "missing",
                supportedModes: ["default"],
                defaultMode: "default",
                setupActions: [
                  {
                    id: "codex-auth",
                    kind: "foreground_terminal",
                    label: "Connect Codex",
                    command: "matrix setup codex",
                  },
                ],
              },
            ],
            projects: { items: [], hasMore: false, limit: 20 },
            activeThreads: { items: [], hasMore: false, limit: 20 },
            attentionThreads: { items: [], hasMore: false, limit: 20 },
            terminalSessions: { items: [], hasMore: false, limit: 20 },
            recentActivity: { items: [], hasMore: false, limit: 20 },
            limits: {
              maxPromptBytes: 16384,
              maxAttachmentCount: 8,
              maxTerminalInputBytes: 8192,
              maxListItems: 20,
            },
            serverTime: "2026-07-08T00:00:00.000Z",
          });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(() => () => undefined),
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the additive runtime and provider controls and sends revisioned updates", async () => {
    const current = {
      identity: {},
      kernel: { model: null, effort: null },
      availableModels: [{ id: "sonnet", label: "Sonnet", tier: "Balanced" }],
      availableEfforts: ["medium"],
      defaults: { model: "sonnet", effort: "medium" },
      contractVersion: 2,
      revision: 7,
      chat: {
        provider: "anthropic",
        model: "sonnet",
        effort: "medium",
        source: "default",
        authKind: "platform",
      },
      runtime: {
        selected: "hermes",
        transition: null,
        options: [
          {
            id: "hermes",
            displayName: "Hermes",
            installState: "installed",
            health: "healthy",
            selectionState: "active",
            configured: true,
            capabilities: ["provider_catalog", "model_selection", "authentication"],
          },
          {
            id: "openclaw",
            displayName: "OpenClaw",
            installState: "installed",
            health: "stopped",
            selectionState: "available",
            configured: false,
            capabilities: ["provider_catalog", "model_selection", "authentication"],
          },
        ],
      },
      providers: [
        {
          id: "anthropic",
          displayName: "Anthropic",
          runtime: null,
          scopes: ["chat"],
          authKind: "platform",
          supportedAuthKinds: ["platform", "api_key", "oauth_login"],
          models: [{
            id: "sonnet",
            displayName: "Sonnet",
            capabilities: ["tools", "reasoning"],
            efforts: ["medium"],
            available: true,
          }],
          authStatus: { state: "ready", authenticated: true, action: "none" },
        },
        {
          id: "openrouter",
          displayName: "OpenRouter",
          runtime: "hermes",
          scopes: ["messaging"],
          authKind: "api_key",
          supportedAuthKinds: ["api_key"],
          models: [{
            id: "openrouter/auto",
            displayName: "Auto",
            capabilities: ["tools"],
            efforts: [],
            available: true,
          }],
          authStatus: {
            state: "action_required",
            authenticated: false,
            action: "enter_api_key",
          },
        },
      ],
      currentSelection: {
        chat: {
          provider: "anthropic",
          model: "sonnet",
          effort: "medium",
          source: "default",
          authKind: "platform",
        },
        messaging: {
          runtime: "hermes",
          provider: "openrouter",
          model: "openrouter/auto",
          configured: true,
        },
      },
    };
    api.get.mockImplementation((path: string) => {
      if (path === "/api/settings/agent") return Promise.resolve(current);
      if (path === "/api/agents/credentials/status") return Promise.resolve({});
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    api.put.mockResolvedValue(current);
    api.post.mockResolvedValue({ valid: true });

    render(<AgentSection />);

    expect(await screen.findByText("Messaging runtime")).toBeTruthy();
    expect(screen.getByText("Hermes is active")).toBeTruthy();
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("OpenRouter")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Use OpenClaw" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(
      "/api/settings/agent",
      { runtime: "openclaw", revision: 7 },
    ));

    fireEvent.click(screen.getByRole("button", { name: "Use my API key" }));
    const keyInput = screen.getByLabelText("Anthropic API key") as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "sk-ant-desktop-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save API key" }));
    expect(keyInput.value).toBe("");
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/api/settings/api-key",
      { apiKey: "sk-ant-desktop-test" },
    ));

    fireEvent.click(screen.getByRole("button", { name: "Configure Hermes provider" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/api/terminal/sessions",
      expect.objectContaining({ cmd: "hermes model", cwd: "projects" }),
    ));
  });

  it("shows a runtime update fallback for older gateways", async () => {
    render(<AgentSection />);

    expect(await screen.findByText("Runtime update needed")).toBeTruthy();
    expect(screen.getByText(/needs a newer gateway for runtime and provider controls/i)).toBeTruthy();
  });

  it("replaces a stale legacy fallback when a current-contract load is malformed", async () => {
    render(<AgentSection />);
    expect(await screen.findByText("Runtime update needed")).toBeTruthy();

    const invalidApi = {
      ...api,
      get: vi.fn((path: string) => path === "/api/settings/agent"
        ? Promise.resolve({ contractVersion: 2 })
        : Promise.resolve({})),
    };
    act(() => useConnection.setState({ api: invalidApi as never }));

    await waitFor(() => expect(screen.queryByText("Runtime update needed")).toBeNull());
    expect(screen.getAllByText("Something went wrong. Please try again.").length).toBeGreaterThan(0);
  });

  it("replaces a stale legacy fallback when a current-contract mutation is malformed", async () => {
    const current = {
      identity: {},
      kernel: { model: null, effort: null },
      availableModels: [{ id: "sonnet", label: "Sonnet", tier: "Balanced" }],
      availableEfforts: ["medium"],
      defaults: { model: "sonnet", effort: "medium" },
      contractVersion: 2,
      revision: 7,
      chat: {
        provider: "anthropic",
        model: "sonnet",
        effort: "medium",
        source: "default",
        authKind: "platform",
      },
      runtime: {
        selected: "hermes",
        transition: null,
        options: [
          {
            id: "hermes",
            displayName: "Hermes",
            installState: "installed",
            health: "healthy",
            selectionState: "active",
            configured: true,
            capabilities: ["provider_catalog", "model_selection", "authentication"],
          },
          {
            id: "openclaw",
            displayName: "OpenClaw",
            installState: "installed",
            health: "stopped",
            selectionState: "available",
            configured: false,
            capabilities: ["provider_catalog", "model_selection", "authentication"],
          },
        ],
      },
      providers: [
        {
          id: "anthropic",
          displayName: "Anthropic",
          runtime: null,
          scopes: ["chat"],
          authKind: "platform",
          supportedAuthKinds: ["platform", "api_key", "oauth_login"],
          models: [{
            id: "sonnet",
            displayName: "Sonnet",
            capabilities: ["tools", "reasoning"],
            efforts: ["medium"],
            available: true,
          }],
          authStatus: { state: "ready", authenticated: true, action: "none" },
        },
        {
          id: "openrouter",
          displayName: "OpenRouter",
          runtime: "hermes",
          scopes: ["messaging"],
          authKind: "api_key",
          supportedAuthKinds: ["api_key"],
          models: [{
            id: "openrouter/auto",
            displayName: "Auto",
            capabilities: ["tools"],
            efforts: [],
            available: true,
          }],
          authStatus: { state: "action_required", authenticated: false, action: "enter_api_key" },
        },
      ],
      currentSelection: {
        chat: {
          provider: "anthropic",
          model: "sonnet",
          effort: "medium",
          source: "default",
          authKind: "platform",
        },
        messaging: {
          runtime: "hermes",
          provider: "openrouter",
          model: "openrouter/auto",
          configured: true,
        },
      },
    };
    api.get.mockImplementation((path: string) => path === "/api/settings/agent"
      ? Promise.resolve(current)
      : Promise.resolve({}));
    let resolveMutation!: (value: unknown) => void;
    api.put.mockReturnValue(new Promise((resolve) => {
      resolveMutation = resolve;
    }));
    render(<AgentSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Use OpenClaw" }));
    const legacyApi = {
      ...api,
      get: vi.fn((path: string) => path === "/api/settings/agent"
        ? Promise.resolve({
          kernel: { model: null, effort: null },
          availableModels: [{ id: "sonnet", label: "Sonnet", tier: "Balanced" }],
          availableEfforts: ["medium"],
          defaults: { model: "sonnet", effort: "medium" },
        })
        : Promise.resolve({})),
    };
    act(() => useConnection.setState({ api: legacyApi as never }));
    expect(await screen.findByText("Runtime update needed")).toBeTruthy();

    await act(async () => resolveMutation({ contractVersion: 2 }));

    await waitFor(() => expect(screen.queryByText("Runtime update needed")).toBeNull());
    expect(screen.getAllByText("Something went wrong. Please try again.").length).toBeGreaterThan(0);
  });

  it("does not crash when provider status omits agents", async () => {
    render(<AgentSection />);

    await screen.findByText("Coding agents & credentials");
    await waitFor(() => {
      expect(screen.queryByText("Checking provider status...")).toBeNull();
    });
  });

  it("clears the model save timer on unmount", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = render(<AgentSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Opus" }));
    const saveButtons = screen.getAllByRole("button", { name: /save/i }) as HTMLButtonElement[];
    const enabledSave = saveButtons.find((button) => !button.disabled);
    expect(enabledSave).toBeTruthy();
    fireEvent.click(enabledSave!);

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/settings/agent", { model: "opus", effort: "medium" }));
    await screen.findByText("Saved");

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("clears a stale model save error after a successful retry", async () => {
    api.put
      .mockRejectedValueOnce(new Error("first save failed"))
      .mockResolvedValueOnce({ ok: true });
    render(<AgentSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Opus" }));
    const findEnabledSave = () =>
      (screen.getAllByRole("button", { name: /save/i }) as HTMLButtonElement[]).find(
        (button) => !button.disabled,
      );

    fireEvent.click(findEnabledSave()!);
    await screen.findByText("Something went wrong. Please try again.");

    fireEvent.click(findEnabledSave()!);

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    await screen.findByText("Saved");
    expect(screen.queryByText("Something went wrong. Please try again.")).toBeNull();
  });

  it("shows runtime provider setup status and opens foreground setup terminals", async () => {
    api.post.mockResolvedValue({ name: "matrix-setup-codex" });
    render(<AgentSection />);

    expect(await screen.findByText("Coding agent providers")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Auth required · installed / missing")).toBeTruthy();
    expect(screen.queryByText("matrix setup codex")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open provider setup Connect Codex" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/terminal/sessions", expect.objectContaining({
      cmd: "matrix setup codex",
      cwd: "projects",
    })));
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "terminal" && tab.title === "Connect Codex")).toBe(true);
  });

  it("refreshes runtime provider setup status after runtime changes", async () => {
    window.operator.invoke = vi.fn((channel: string) => {
      if (channel !== "runtime:get-summary") return Promise.resolve({});
      const runtimeSlot = useConnection.getState().runtimeSlot;
      return Promise.resolve({
        runtime: {
          id: runtimeSlot === "secondary" ? "rt_secondary" : "rt_primary",
          label: runtimeSlot === "secondary" ? "Secondary" : "Primary",
          status: "available",
        },
        capabilities: [{ id: "codingAgentsRuntimeSummary", enabled: true }],
        providers: [
          runtimeSlot === "secondary"
            ? {
                id: "claude",
                kind: "claude",
                displayName: "Claude",
                availability: "available",
                installStatus: "installed",
                authStatus: "authenticated",
                supportedModes: ["default"],
                defaultMode: "default",
                setupActions: [],
              }
            : {
                id: "codex",
                kind: "codex",
                displayName: "Codex",
                availability: "auth_required",
                installStatus: "installed",
                authStatus: "missing",
                supportedModes: ["default"],
                defaultMode: "default",
                setupActions: [],
              },
        ],
        projects: { items: [], hasMore: false, limit: 20 },
        activeThreads: { items: [], hasMore: false, limit: 20 },
        attentionThreads: { items: [], hasMore: false, limit: 20 },
        terminalSessions: { items: [], hasMore: false, limit: 20 },
        recentActivity: { items: [], hasMore: false, limit: 20 },
        limits: {
          maxPromptBytes: 16384,
          maxAttachmentCount: 8,
          maxTerminalInputBytes: 8192,
          maxListItems: 20,
        },
        serverTime: "2026-07-08T00:00:00.000Z",
      });
    });

    render(<AgentSection />);

    expect(await screen.findByText("Codex")).toBeTruthy();

    act(() => {
      useConnection.setState({ runtimeSlot: "secondary" });
    });

    await screen.findByText("Claude");
    expect(screen.queryByText("Codex")).toBeNull();
    expect(window.operator.invoke).toHaveBeenCalledWith("runtime:get-summary", {});
    expect(window.operator.invoke).toHaveBeenCalledTimes(2);
  });
});
