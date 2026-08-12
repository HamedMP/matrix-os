import { describe, expect, it } from "vitest";
import type { HermesConfiguration, HermesEnvironment } from "@matrix-os/contracts";
import {
  configValueAt,
  configurationCategories,
  isCurrentRequestRevision,
  matchingConfigurationFields,
  matchingCredentials,
  parseHermesList,
  setConfigValue,
  titleCase,
  valuesEqual,
} from "../../desktop/src/renderer/src/features/settings/hermes/hermes-form-model";

const configuration: HermesConfiguration = {
  config: {
    general: { model: "anthropic/claude-opus-4.6", quiet: false },
    agent: { model_context_length: 0 },
  },
  defaults: {
    general: { model: "", quiet: true },
    agent: { model_context_length: 200_000 },
  },
  fields: {
    "general.model": { type: "string", description: "Default model", category: "general" },
    "general.quiet": { type: "boolean", description: "Quiet mode", category: "general" },
    "agent.model_context_length": {
      type: "number",
      description: "Context window override",
      category: "agent",
    },
  },
  categoryOrder: ["general", "agent"],
};

const environment: HermesEnvironment = {
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
    description: "Claude models",
    category: "Providers",
    is_password: true,
    tools: ["hermes"],
    advanced: false,
    channel_managed: false,
    provider: "anthropic",
    provider_label: "Anthropic",
  },
};

describe("Desktop Hermes form model", () => {
  it("orders categories from the schema and reports bounded field counts", () => {
    expect(configurationCategories(configuration)).toEqual([
      { id: "general", label: "General", count: 2 },
      { id: "agent", label: "Agent", count: 1 },
    ]);
    expect(titleCase("browser_tools")).toBe("Browser Tools");
  });

  it("searches all categories without changing the selected category", () => {
    expect(matchingConfigurationFields(configuration, "context", "general").map(([path]) => path))
      .toEqual(["agent.model_context_length"]);
    expect(matchingConfigurationFields(configuration, "", "general").map(([path]) => path))
      .toEqual(["general.model", "general.quiet"]);
  });

  it("reads and immutably updates nested draft values", () => {
    const next = setConfigValue(configuration.config, "general.model", "openai/gpt-5");

    expect(configValueAt(next, "general.model")).toBe("openai/gpt-5");
    expect(configValueAt(configuration.config, "general.model")).toBe("anthropic/claude-opus-4.6");
    expect(configValueAt(next, "missing.path")).toBeUndefined();
    expect(valuesEqual(["codex", 2], ["codex", 2])).toBe(true);
    expect(valuesEqual(["codex", 2], ["codex", 3])).toBe(false);
  });

  it("accepts only bounded scalar JSON lists", () => {
    expect(parseHermesList('["codex", 2, true]')).toEqual(["codex", 2, true]);
    expect(parseHermesList('[{"secret":"x"}]')).toBeNull();
    expect(parseHermesList("not-json")).toBeNull();
    expect(parseHermesList(JSON.stringify(Array.from({ length: 129 }, () => "x")))).toBeNull();
  });

  it("sorts configured credentials first and searches metadata only", () => {
    expect(matchingCredentials(environment, "").map(([key]) => key)).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ]);
    expect(matchingCredentials(environment, "openai").map(([key]) => key)).toEqual([
      "OPENAI_API_KEY",
    ]);
  });

  it("rejects stale async revisions", () => {
    expect(isCurrentRequestRevision(4, 4)).toBe(true);
    expect(isCurrentRequestRevision(5, 4)).toBe(false);
  });
});
