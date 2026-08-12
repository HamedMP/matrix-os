import { describe, expect, it } from "vitest";
import {
  HermesConfigurationChangeRequestSchema,
  HermesConfigurationSchema,
  HermesCredentialRemoveRequestSchema,
  HermesCredentialSetRequestSchema,
  HermesEnvironmentSchema,
} from "@matrix-os/contracts";

const anthropicCredential = {
  is_set: true,
  redacted_value: "sk-ant-...last4",
  description: "Anthropic API key",
  url: "https://console.anthropic.com/",
  category: "model",
  is_password: true,
  tools: ["hermes"],
  advanced: false,
  channel_managed: false,
  provider: "anthropic",
  provider_label: "Anthropic",
};

describe("Hermes configuration contracts", () => {
  it("accepts credential metadata and rejects stored credential values", () => {
    expect(HermesEnvironmentSchema.safeParse({
      ANTHROPIC_API_KEY: anthropicCredential,
    }).success).toBe(true);

    expect(HermesEnvironmentSchema.safeParse({
      ANTHROPIC_API_KEY: {
        ...anthropicCredential,
        value: "secret",
      },
    }).success).toBe(false);
  });

  it("parses bounded dynamic settings and rejects oversized field catalogs", () => {
    const configuration = {
      config: { general: { model: "anthropic/claude-opus-4.6" } },
      defaults: { general: { model: "" } },
      fields: {
        "general.model": {
          type: "string",
          description: "Default model",
          category: "general",
        },
      },
      categoryOrder: ["general"],
    };

    expect(HermesConfigurationSchema.safeParse(configuration).success).toBe(true);
    expect(HermesConfigurationSchema.safeParse({
      ...configuration,
      fields: Object.fromEntries(Array.from({ length: 1_025 }, (_, index) => [
        `general.field_${index}`,
        configuration.fields["general.model"],
      ])),
    }).success).toBe(false);
  });

  it("accepts only bounded typed configuration patches", () => {
    expect(HermesConfigurationChangeRequestSchema.safeParse({
      changes: [
        { path: "general.model", value: "anthropic/claude-opus-4.6" },
        { path: "display.compact", value: true },
        { path: "agent.max_steps", value: 40 },
        { path: "agent.fallbacks", value: ["openrouter", 2, false] },
      ],
    }).success).toBe(true);

    expect(HermesConfigurationChangeRequestSchema.safeParse({
      changes: [{ path: "general.model", value: { secret: "nested" } }],
    }).success).toBe(false);
    expect(HermesConfigurationChangeRequestSchema.safeParse({
      changes: Array.from({ length: 65 }, (_, index) => ({
        path: `general.field_${index}`,
        value: true,
      })),
    }).success).toBe(false);
  });

  it("bounds write-only credential mutations", () => {
    expect(HermesCredentialSetRequestSchema.safeParse({
      key: "ANTHROPIC_API_KEY",
      value: "secret",
    }).success).toBe(true);
    expect(HermesCredentialSetRequestSchema.safeParse({
      key: "anthropic-api-key",
      value: "secret",
    }).success).toBe(false);
    expect(HermesCredentialSetRequestSchema.safeParse({
      key: "ANTHROPIC_API_KEY",
      value: "x".repeat(4_097),
    }).success).toBe(false);
    expect(HermesCredentialRemoveRequestSchema.safeParse({
      key: "OPENROUTER_API_KEY",
    }).success).toBe(true);
  });
});
