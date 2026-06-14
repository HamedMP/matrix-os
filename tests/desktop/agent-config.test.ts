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
