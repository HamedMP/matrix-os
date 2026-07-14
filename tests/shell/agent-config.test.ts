import { describe, expect, it, vi } from "vitest";
import type { AgentSettingsView } from "@matrix-os/contracts";
import {
  AgentSettingsClientError,
  loadAgentSettings,
  normalizeAgentSettings,
  saveAnthropicApiKey,
  safeAgentSettingsError,
  updateAgentSettings,
} from "../../shell/src/lib/agent-config.js";

const chat = {
  provider: "anthropic",
  model: "claude-opus-4-6",
  effort: "high",
  source: "saved",
  authKind: "platform",
} as const;

export function currentAgentSettingsView(): AgentSettingsView {
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

describe("shell agent settings wire client", () => {
  it("accepts the bounded additive contract", () => {
    const result = normalizeAgentSettings(currentAgentSettingsView());
    expect(result).toMatchObject({ kind: "current", view: { revision: 4 } });
  });

  it("keeps legacy model and effort usable while requiring a runtime update", () => {
    const result = normalizeAgentSettings({
      identity: {},
      kernel: { model: "claude-sonnet-4-6", effort: "medium" },
      availableModels: [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "Balanced" }],
      availableEfforts: ["low", "medium", "high"],
      defaults: { model: "claude-opus-4-6", effort: "high" },
    });
    expect(result).toMatchObject({
      kind: "legacy",
      model: "claude-sonnet-4-6",
      effort: "medium",
      updateRequired: true,
    });
  });

  it("accepts the oldest partial legacy response without inventing selections", () => {
    const result = normalizeAgentSettings({
      identity: {},
      kernel: { model: null, effort: null },
    });
    expect(result).toMatchObject({
      kind: "legacy",
      model: null,
      effort: null,
      updateRequired: true,
    });
  });

  it("rejects malformed and oversized responses without reflecting their content", async () => {
    expect(() => normalizeAgentSettings({ providers: [{ apiKey: "sk-secret" }] }))
      .toThrow(AgentSettingsClientError);
    const fetcher = vi.fn(async () => new Response("x".repeat(1_048_577)));
    await expect(loadAgentSettings({ fetcher })).rejects.toMatchObject({
      kind: "invalid_response",
      message: "Agent settings are unavailable.",
    });
  });

  it("allowlists client-facing errors", () => {
    expect(safeAgentSettingsError("agent_config_conflict")).toBe(
      "Agent settings changed elsewhere. Refresh and try again.",
    );
    expect(safeAgentSettingsError("Anthropic /home/matrix sk-secret failure")).toBe(
      "Agent settings could not be updated.",
    );
  });

  it("uses abortable credential-free settings requests", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (init?.method === "PUT") {
        return Response.json({ ok: true, kernel: { model: chat.model, effort: "low" } });
      }
      return Response.json(currentAgentSettingsView());
    });

    await expect(loadAgentSettings({ fetcher })).resolves.toMatchObject({ kind: "current" });
    await expect(updateAgentSettings({ effort: "low" }, { fetcher }))
      .resolves.toMatchObject({ kind: "current" });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/api/settings/agent"),
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ effort: "low" }) }),
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("submits a BYOK value only to the existing write-only route", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ valid: true });
    });

    await expect(saveAnthropicApiKey("sk-ant-secret-canary", { fetcher }))
      .resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/settings/api-key"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ apiKey: "sk-ant-secret-canary" }),
      }),
    );
    expect(JSON.stringify(fetcher.mock.calls)).toContain("sk-ant-secret-canary");
  });
});
