import { describe, expect, it } from "vitest";
import {
  normalizeAgentConfig,
  selectedModelEffort,
  type AgentConfigView,
} from "@desktop/renderer/src/lib/agent-config";

describe("normalizeAgentConfig", () => {
  it("returns a safe empty catalog for an older gateway that only sends { identity, kernel }", () => {
    // Deployed gateways before the model-catalog change answer GET
    // /api/settings/agent with just { identity, kernel } — no availableModels.
    const cfg = normalizeAgentConfig({
      identity: { handle: "neo" },
      kernel: { model: "claude-opus-4-6", effort: "high" },
    });
    expect(cfg.availableModels).toEqual([]);
    expect(cfg.availableEfforts).toEqual([]);
    expect(cfg.defaults).toEqual({ model: null, effort: null });
    expect(cfg.kernel).toEqual({ model: "claude-opus-4-6", effort: "high" });
    expect(cfg.extended).toBeNull();
    expect(cfg.runtimeUpdateRequired).toBe(true);
  });

  it("preserves a full catalog and drops malformed model entries", () => {
    const cfg = normalizeAgentConfig({
      kernel: { model: null, effort: null },
      availableModels: [
        { id: "a", label: "A", tier: "Fast" },
        { id: "b" }, // missing label/tier -> dropped
        "nope", // not an object -> dropped
      ],
      availableEfforts: ["low", "high", 5],
      defaults: { model: "a", effort: "low" },
    });
    expect(cfg.availableModels).toEqual([{ id: "a", label: "A", tier: "Fast" }]);
    expect(cfg.availableEfforts).toEqual(["low", "high"]);
    expect(cfg.defaults).toEqual({ model: "a", effort: "low" });
  });

  it("rejects a malformed current contract instead of labeling it as an older gateway", () => {
    expect(() => normalizeAgentConfig({
      contractVersion: 2,
      identity: {},
      kernel: { model: "sonnet", effort: "medium" },
      availableModels: [{ id: "sonnet", label: "Sonnet", tier: "Balanced" }],
      availableEfforts: ["medium"],
      defaults: { model: "sonnet", effort: "medium" },
    })).toThrow("Agent settings response is invalid");
  });

  it("preserves the validated additive runtime and provider contract", () => {
    const cfg = normalizeAgentConfig({
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
            installState: "missing",
            health: "stopped",
            selectionState: "action_required",
            configured: false,
            capabilities: ["install"],
            setupAction: "install",
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
    });

    expect(cfg.runtimeUpdateRequired).toBe(false);
    expect(cfg.extended?.revision).toBe(7);
    expect(cfg.extended?.runtime.selected).toBe("hermes");
    expect(cfg.extended?.providers.map((provider) => provider.displayName)).toEqual([
      "Anthropic",
      "OpenRouter",
    ]);
  });

  it("never throws on garbage input", () => {
    for (const raw of [null, undefined, "x", 42, [], {}]) {
      const cfg = normalizeAgentConfig(raw);
      expect(cfg.availableModels).toEqual([]);
      expect(cfg.availableEfforts).toEqual([]);
      expect(cfg.kernel).toEqual({ model: null, effort: null });
      expect(cfg.defaults).toEqual({ model: null, effort: null });
    }
  });
});

describe("selectedModelEffort", () => {
  const base: AgentConfigView = {
    kernel: { model: null, effort: null },
    availableModels: [],
    availableEfforts: [],
    defaults: { model: null, effort: null },
    extended: null,
    runtimeUpdateRequired: true,
  };

  it("prefers the saved kernel value over defaults", () => {
    expect(
      selectedModelEffort({
        ...base,
        kernel: { model: "k", effort: "high" },
        defaults: { model: "d", effort: "low" },
      }),
    ).toEqual({ model: "k", effort: "high" });
  });

  it("falls back to defaults when the kernel is unset", () => {
    expect(selectedModelEffort({ ...base, defaults: { model: "d", effort: "low" } })).toEqual({
      model: "d",
      effort: "low",
    });
  });

  it("returns nulls (no throw) when neither kernel nor defaults are present", () => {
    // This is the older-gateway case that crashed ModelEffortCard at
    // `cfg.kernel.model ?? cfg.defaults.model` when defaults was undefined.
    expect(selectedModelEffort(base)).toEqual({ model: null, effort: null });
  });
});
