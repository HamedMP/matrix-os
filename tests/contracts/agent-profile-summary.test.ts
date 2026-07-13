import { describe, expect, it } from "vitest";
import { AgentProfileSummarySchema } from "../../packages/contracts/src/index.js";

describe("AgentProfileSummarySchema", () => {
  it("accepts a bounded structured profile without credential material", () => {
    expect(AgentProfileSummarySchema.parse({
      identity: { name: "Hermes", tagline: "A thoughtful operating-system companion." },
      kernel: {
        model: "claude-opus-4-6",
        modelLabel: "Claude Opus 4.6",
        effort: "high",
      },
      credentials: { mode: "platform" },
      soulPreview: "Be genuinely helpful, resourceful, and careful with private information.",
    })).toEqual({
      identity: { name: "Hermes", tagline: "A thoughtful operating-system companion." },
      kernel: {
        model: "claude-opus-4-6",
        modelLabel: "Claude Opus 4.6",
        effort: "high",
      },
      credentials: { mode: "platform" },
      soulPreview: "Be genuinely helpful, resourceful, and careful with private information.",
    });
  });

  it("rejects oversized, unsafe, or secret-bearing response fields", () => {
    const valid = {
      identity: { name: "Hermes" },
      kernel: {
        model: "claude-opus-4-6",
        modelLabel: "Claude Opus 4.6",
        effort: "high" as const,
      },
      credentials: { mode: "platform" as const },
      soulPreview: "A safe preview.",
    };

    expect(AgentProfileSummarySchema.safeParse({
      ...valid,
      soulPreview: "x".repeat(281),
    }).success).toBe(false);
    expect(AgentProfileSummarySchema.safeParse({
      ...valid,
      soulPreview: "Read /opt/matrix/private before replying.",
    }).success).toBe(false);
    expect(AgentProfileSummarySchema.safeParse({
      ...valid,
      credentials: { mode: "sk-ant-secret-material" },
    }).success).toBe(false);
  });
});
