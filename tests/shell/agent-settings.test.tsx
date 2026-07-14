// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsViewSchema, type AgentSettingsView } from "@matrix-os/contracts";
import { AgentRuntimePanel } from "../../shell/src/components/settings/sections/AgentRuntimePanel.js";

function makeView(): AgentSettingsView {
  const chat = {
    provider: "anthropic",
    model: "claude-opus-4-6",
    effort: "high",
    source: "saved",
    authKind: "platform",
  } as const;
  return {
    identity: {},
    kernel: { model: chat.model, effort: chat.effort },
    availableModels: [{ id: chat.model, label: "Claude Opus 4.6", tier: "Most capable" }],
    availableEfforts: ["low", "medium", "high", "max"],
    defaults: { model: chat.model, effort: chat.effort },
    contractVersion: 2,
    revision: 4,
    chat,
    runtime: {
      selected: "hermes",
      options: [
        {
          id: "hermes",
          displayName: "Hermes",
          installState: "installed",
          health: "healthy",
          selectionState: "active",
          configured: true,
          capabilities: ["provider_catalog", "model_selection", "authentication", "messaging_dashboard"],
          version: "1.2.0",
        },
        {
          id: "openclaw",
          displayName: "OpenClaw",
          installState: "missing",
          health: "stopped",
          selectionState: "unavailable",
          configured: false,
          capabilities: ["install"],
          setupAction: "install",
        },
      ],
      transition: null,
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
          id: chat.model,
          displayName: "Claude Opus 4.6",
          capabilities: ["tools", "vision", "reasoning"],
          efforts: ["low", "medium", "high", "max"],
          available: true,
        }],
        authStatus: { state: "ready", authenticated: true, action: "none" },
      },
      {
        id: "nous",
        displayName: "Nous Research",
        runtime: "hermes",
        scopes: ["messaging"],
        authKind: "oauth_login",
        supportedAuthKinds: ["oauth_login"],
        models: [{
          id: "hermes-4-405b",
          displayName: "Hermes 4 405B",
          capabilities: ["tools"],
          efforts: [],
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
          id: "qwen-3-coder",
          displayName: "Qwen 3 Coder",
          capabilities: ["tools"],
          efforts: [],
          available: true,
        }],
        authStatus: { state: "action_required", authenticated: false, action: "enter_api_key" },
      },
    ],
    currentSelection: {
      chat,
      messaging: {
        runtime: "hermes",
        provider: "nous",
        model: "hermes-4-405b",
        configured: true,
      },
    },
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Canvas Agent runtime settings", () => {
  it("renders current Chat, runtime health, providers, and secure setup actions", async () => {
    const view = makeView();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/settings/api-key")) return response({ valid: true });
      return response(view);
    });
    vi.stubGlobal("fetch", fetcher);
    const onOpenTerminal = vi.fn();
    render(<AgentRuntimePanel onOpenTerminal={onOpenTerminal} />);

    expect(await screen.findByText("Claude Opus 4.6")).toBeVisible();
    expect(screen.getByText("Hermes")).toBeVisible();
    expect(screen.getByText("OpenClaw")).toBeVisible();
    expect(screen.getByText("Not installed")).toBeVisible();
    expect(screen.getAllByText("Nous Research").some((element) => element.tagName === "SPAN")).toBe(true);
    expect(screen.getByText("Healthy")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Choose OpenRouter" }));
    expect(screen.getByRole("combobox", { name: "Messaging model" })).toHaveValue("qwen-3-coder");

    fireEvent.click(screen.getByRole("button", { name: "Use my API key" }));
    const keyInput = screen.getByLabelText("Anthropic API key");
    expect(keyInput).toHaveAttribute("type", "password");
    fireEvent.change(keyInput, { target: { value: "sk-ant-secret-canary" } });
    fireEvent.click(screen.getByRole("button", { name: "Save API key" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/api-key"),
      expect.objectContaining({ method: "POST" }),
    ));
    await waitFor(() => expect(keyInput).toHaveValue(""));

    fireEvent.click(screen.getByRole("button", { name: "Sign in with Claude" }));
    expect(onOpenTerminal).toHaveBeenCalledWith("claude-login");
    fireEvent.click(screen.getByRole("button", { name: "Configure Hermes provider" }));
    expect(onOpenTerminal).toHaveBeenCalledWith("hermes-model");
  });

  it("switches only to an installed runtime with the current revision", async () => {
    const initial = makeView();
    initial.runtime.options[1] = {
      id: "openclaw",
      displayName: "OpenClaw",
      installState: "installed",
      health: "stopped",
      selectionState: "available",
      configured: false,
      capabilities: ["provider_catalog", "model_selection", "authentication"],
    };
    const updated = structuredClone(initial);
    updated.runtime.selected = "openclaw";
    updated.runtime.options[0].selectionState = "available";
    updated.runtime.options[1].selectionState = "active";
    updated.runtime.options[1].health = "healthy";
    updated.currentSelection.messaging = {
      runtime: "openclaw",
      provider: null,
      model: null,
      configured: false,
    };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "PUT" ? response(updated) : response(initial)
    ));
    vi.stubGlobal("fetch", fetcher);
    render(<AgentRuntimePanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Use OpenClaw" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/agent"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ runtime: "openclaw", revision: 4 }),
      }),
    ));
    expect(await screen.findByText("OpenClaw is active")).toBeVisible();
  });

  it("never falls back to an unavailable messaging model", async () => {
    const initial = makeView();
    initial.providers[1].models = [
      {
        id: "offline-model",
        displayName: "Offline model",
        capabilities: [],
        efforts: [],
        available: false,
      },
      {
        id: "ready-model",
        displayName: "Ready model",
        capabilities: ["tools"],
        efforts: [],
        available: true,
      },
    ];
    initial.currentSelection.messaging = {
      runtime: "hermes",
      provider: "nous",
      model: "offline-model",
      configured: true,
    };
    AgentSettingsViewSchema.parse(initial);
    const fetcher = vi.fn(async () => response(initial));
    vi.stubGlobal("fetch", fetcher);
    render(<AgentRuntimePanel />);

    expect(await screen.findByRole("combobox", { name: "Messaging model" })).toHaveValue("ready-model");
    fireEvent.click(screen.getByRole("button", { name: "Save messaging model" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/agent"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          provider: "nous",
          messagingModel: "ready-model",
          revision: 4,
        }),
      }),
    ));
  });

  it("never saves an unavailable Chat model", async () => {
    const initial = makeView();
    initial.providers[0].models = [
      {
        id: "claude-opus-4-6",
        displayName: "Claude Opus 4.6",
        capabilities: ["tools", "vision", "reasoning"],
        efforts: ["low", "medium", "high", "max"],
        available: false,
      },
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        capabilities: ["tools", "vision", "reasoning"],
        efforts: ["low", "medium", "high"],
        available: true,
      },
    ];
    AgentSettingsViewSchema.parse(initial);
    const fetcher = vi.fn(async () => response(initial));
    vi.stubGlobal("fetch", fetcher);
    render(<AgentRuntimePanel />);

    expect(await screen.findByRole("combobox", { name: "Chat model" })).toHaveValue("claude-sonnet-4-6");
    fireEvent.click(screen.getByRole("button", { name: "Save Chat model" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/agent"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          effort: "high",
        }),
      }),
    ));
  });

  it("reconciles Chat model state when a settings refresh changes availability", async () => {
    const initial = makeView();
    const refreshed = structuredClone(initial);
    refreshed.providers[0].models = [
      {
        id: "claude-opus-4-6",
        displayName: "Claude Opus 4.6",
        capabilities: ["tools", "vision", "reasoning"],
        efforts: ["low", "medium", "high", "max"],
        available: false,
      },
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        capabilities: ["tools", "vision", "reasoning"],
        efforts: ["low", "medium", "high"],
        available: true,
      },
    ];
    AgentSettingsViewSchema.parse(refreshed);
    let putCalls = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCalls += 1;
        return response(refreshed);
      }
      return response(initial);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AgentRuntimePanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Save Chat model" }));
    await waitFor(() => expect(putCalls).toBe(1));
    expect(screen.getByRole("combobox", { name: "Chat model" })).toHaveValue("claude-sonnet-4-6");
    fireEvent.click(screen.getByRole("button", { name: "Save Chat model" }));

    await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith(
      expect.stringContaining("/api/settings/agent"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ model: "claude-sonnet-4-6", effort: "high" }),
      }),
    ));
  });

  it("reconciles Messaging model state when a settings refresh changes availability", async () => {
    const initial = makeView();
    const refreshed = structuredClone(initial);
    refreshed.providers[1].models = [
      {
        id: "hermes-4-405b",
        displayName: "Hermes 4 405B",
        capabilities: ["tools"],
        efforts: [],
        available: false,
      },
      {
        id: "hermes-4-70b",
        displayName: "Hermes 4 70B",
        capabilities: ["tools"],
        efforts: [],
        available: true,
      },
    ];
    AgentSettingsViewSchema.parse(refreshed);
    let putCalls = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCalls += 1;
        return response(refreshed);
      }
      return response(initial);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AgentRuntimePanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Save messaging model" }));
    await waitFor(() => expect(putCalls).toBe(1));
    expect(screen.getByRole("combobox", { name: "Messaging model" })).toHaveValue("hermes-4-70b");
    fireEvent.click(screen.getByRole("button", { name: "Save messaging model" }));

    await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith(
      expect.stringContaining("/api/settings/agent"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          provider: "nous",
          messagingModel: "hermes-4-70b",
          revision: 4,
        }),
      }),
    ));
  });

  it("shows a useful legacy fallback and retryable safe error state", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return response({ error: "internal /home/matrix provider detail" }, 503);
      return response({
        identity: {},
        kernel: { model: "claude-sonnet-4-6", effort: "medium" },
        availableModels: [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "Balanced" }],
        availableEfforts: ["low", "medium", "high"],
        defaults: { model: "claude-opus-4-6", effort: "high" },
      });
    }));
    render(<AgentRuntimePanel />);

    expect(await screen.findByText("Agent settings could not be updated.")).toBeVisible();
    expect(screen.queryByText(/home\/matrix/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Runtime update needed")).toBeVisible();
    const legacy = screen.getByRole("region", { name: "Legacy agent settings" });
    expect(within(legacy).getByText("Claude Sonnet 4.6")).toBeVisible();
    expect(within(legacy).getByText("Medium effort")).toBeVisible();
  });
});
