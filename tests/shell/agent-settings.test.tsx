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

function hermesConfiguration() {
  return {
    config: { model: "nous/hermes-4-405b" },
    defaults: { model: "nous/hermes-4-405b" },
    fields: {
      model: { type: "string", description: "Default model", category: "general" },
    },
    categoryOrder: ["general"],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Canvas Agent runtime settings", () => {
  it("renders current Chat, runtime health, providers, and secure setup actions", async () => {
    const view = makeView();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/settings/api-key")) return response({ valid: true });
      if (String(input).endsWith("/api/hermes/configuration")) return response(hermesConfiguration());
      if (String(input).endsWith("/api/hermes/env")) return response({});
      return response(view);
    });
    vi.stubGlobal("fetch", fetcher);
    const onOpenTerminal = vi.fn();
    render(<AgentRuntimePanel onOpenTerminal={onOpenTerminal} />);

    expect(await screen.findByText("Claude Opus 4.6")).toBeVisible();
    expect(screen.getByText("Hermes")).toBeVisible();
    expect(screen.getByText("OpenClaw")).toBeVisible();
    expect(screen.getByText("Not installed")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Install OpenClaw" }));
    expect(onOpenTerminal).toHaveBeenCalledWith("openclaw-install");
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
    expect(await screen.findByRole("heading", { name: "Configure Hermes" })).toBeVisible();
    expect(onOpenTerminal).not.toHaveBeenCalledWith(expect.stringContaining("hermes"));
  });

  it("offers visible provider setup when the selected runtime has no catalog", async () => {
    const view = makeView();
    view.providers = view.providers.filter((provider) => provider.runtime !== "hermes");
    view.currentSelection.messaging = {
      runtime: "hermes",
      provider: null,
      model: null,
      configured: false,
    };
    view.runtime.options[0].configured = false;
    const onOpenTerminal = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/hermes/configuration")) return response(hermesConfiguration());
      if (String(input).endsWith("/api/hermes/env")) return response({});
      return response(view);
    }));

    render(<AgentRuntimePanel onOpenTerminal={onOpenTerminal} />);

    fireEvent.click(await screen.findByRole("button", { name: "Configure Hermes provider" }));
    expect(await screen.findByRole("heading", { name: "Configure Hermes" })).toBeVisible();
    expect(onOpenTerminal).not.toHaveBeenCalledWith(expect.stringContaining("hermes"));
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

  it("clears a stale Chat effort when the available model has no effort choices", async () => {
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
        efforts: [],
        available: true,
      },
    ];
    AgentSettingsViewSchema.parse(initial);
    const fetcher = vi.fn(async () => response(initial));
    vi.stubGlobal("fetch", fetcher);
    render(<AgentRuntimePanel />);

    expect(await screen.findByRole("combobox", { name: "Chat model" })).toHaveValue("claude-sonnet-4-6");
    expect(screen.getByRole("combobox", { name: "Chat effort" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save Chat model" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/agent"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ model: "claude-sonnet-4-6", effort: null }),
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

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
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

  it("discards unsaved local selections after a failed settings mutation", async () => {
    const initial = makeView();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "PUT"
        ? response({ error: "agent_config_conflict" }, 409)
        : response(initial)
    ));
    vi.stubGlobal("fetch", fetcher);
    render(<AgentRuntimePanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Choose OpenRouter" }));
    expect(screen.getByRole("combobox", { name: "Messaging model" })).toHaveValue("qwen-3-coder");
    fireEvent.click(screen.getByRole("button", { name: "Save messaging model" }));

    expect(await screen.findByText("Agent settings changed elsewhere. Refresh and try again.")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Messaging model" })).toHaveValue("hermes-4-405b");
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
    expect(within(legacy).getByRole("combobox", { name: "Legacy Chat effort" })).toHaveValue("medium");
  });

  it("keeps legacy Chat model and effort controls editable", async () => {
    const legacy = {
      identity: {},
      kernel: { model: "claude-sonnet-4-6", effort: "medium" },
      availableModels: [
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "Balanced" },
        { id: "claude-opus-4-6", label: "Claude Opus 4.6", tier: "Most capable" },
      ],
      availableEfforts: ["low", "medium", "high"],
      defaults: { model: "claude-opus-4-6", effort: "high" },
    };
    const fetcher = vi.fn(async () => response(legacy));
    vi.stubGlobal("fetch", fetcher);
    render(<AgentRuntimePanel />);

    const region = await screen.findByRole("region", { name: "Legacy agent settings" });
    fireEvent.change(within(region).getByRole("combobox", { name: "Legacy Chat model" }), {
      target: { value: "claude-opus-4-6" },
    });
    fireEvent.change(within(region).getByRole("combobox", { name: "Legacy Chat effort" }), {
      target: { value: "high" },
    });
    fireEvent.click(within(region).getByRole("button", { name: "Save Chat model" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/agent"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ model: "claude-opus-4-6", effort: "high" }),
      }),
    ));
  });

  it("reconciles legacy edits after a successful catalog refresh", async () => {
    const initial = {
      identity: {},
      kernel: { model: "claude-sonnet-4-6", effort: "medium" },
      availableModels: [
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "Balanced" },
        { id: "claude-opus-4-6", label: "Claude Opus 4.6", tier: "Most capable" },
      ],
      availableEfforts: ["low", "medium", "high"],
      defaults: { model: "claude-sonnet-4-6", effort: "medium" },
    };
    const refreshed = {
      ...initial,
      kernel: { model: "claude-opus-4-6", effort: "high" },
      availableModels: [initial.availableModels[0]],
      availableEfforts: ["low", "medium"],
    };
    let updated = false;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        updated = true;
        return response({ ok: true });
      }
      return response(updated ? refreshed : initial);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AgentRuntimePanel />);

    const region = await screen.findByRole("region", { name: "Legacy agent settings" });
    fireEvent.change(within(region).getByRole("combobox", { name: "Legacy Chat model" }), {
      target: { value: "claude-opus-4-6" },
    });
    fireEvent.change(within(region).getByRole("combobox", { name: "Legacy Chat effort" }), {
      target: { value: "high" },
    });
    fireEvent.click(within(region).getByRole("button", { name: "Save Chat model" }));

    await waitFor(() => expect(
      within(screen.getByRole("region", { name: "Legacy agent settings" }))
        .queryByRole("option", { name: "Claude Opus 4.6" }),
    ).toBeNull());
    const refreshedRegion = screen.getByRole("region", { name: "Legacy agent settings" });
    fireEvent.click(within(refreshedRegion).getByRole("button", { name: "Save Chat model" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/agent"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ model: "claude-sonnet-4-6", effort: null }),
      }),
    ));
  });

  it("clears a legacy saved effort that is no longer available", async () => {
    const legacy = {
      identity: {},
      kernel: { model: "claude-sonnet-4-6", effort: "max" },
      availableModels: [
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "Balanced" },
      ],
      availableEfforts: ["low", "medium", "high"],
      defaults: { model: "claude-sonnet-4-6", effort: "medium" },
    };
    const fetcher = vi.fn(async () => response(legacy));
    vi.stubGlobal("fetch", fetcher);
    render(<AgentRuntimePanel />);

    const region = await screen.findByRole("region", { name: "Legacy agent settings" });
    expect(within(region).getByRole("combobox", { name: "Legacy Chat effort" })).toHaveValue("");
    fireEvent.click(within(region).getByRole("button", { name: "Save Chat model" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/agent"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ model: "claude-sonnet-4-6", effort: null }),
      }),
    ));
  });

  it("reconciles a stale legacy Chat model before saving", async () => {
    const legacy = {
      identity: {},
      kernel: { model: "claude-retired", effort: "medium" },
      availableModels: [
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "Balanced" },
      ],
      availableEfforts: ["low", "medium", "high"],
      defaults: { model: "claude-sonnet-4-6", effort: "medium" },
    };
    const fetcher = vi.fn(async () => response(legacy));
    vi.stubGlobal("fetch", fetcher);
    render(<AgentRuntimePanel />);

    const region = await screen.findByRole("region", { name: "Legacy agent settings" });
    expect(within(region).getByRole("combobox", { name: "Legacy Chat model" }))
      .toHaveValue("claude-sonnet-4-6");
    fireEvent.click(within(region).getByRole("button", { name: "Save Chat model" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/agent"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ model: "claude-sonnet-4-6", effort: "medium" }),
      }),
    ));
  });
});
