import { describe, expect, it } from "vitest";
import {
  CreateChatAgentRequestSchema,
  ChatRunContextSchema,
  ChatAgentRecipeCatalogSchema,
  ChatAgentRecipeSchema,
  UpdateChatAgentRequestSchema,
} from "@matrix-os/contracts";

const recipe = {
  skills: ["matrix-personal-daily-brief", "matrix-integrations"],
  integrations: [{ service: "gmail" }, { service: "google_calendar" }],
  output: "English daily brief with source links",
};

describe("Chat Agent recipe contract", () => {
  it("adds an optional client recipe to saved Agent configuration", () => {
    const base = {
      clientRequestId: "req_daily_brief",
      name: "Daily brief",
      description: "",
      instructions: "Prepare my day.",
      selection: { instanceId: "hermes_default", model: "openai:gpt-5.6-sol" },
    };
    expect(CreateChatAgentRequestSchema.parse({ ...base, recipe }).recipe).toEqual(recipe);
    expect(CreateChatAgentRequestSchema.parse(base).recipe).toBeUndefined();
    expect(CreateChatAgentRequestSchema.safeParse({
      ...base,
      recipe: { ...recipe, resolved: { instructions: "forged" } },
    }).success).toBe(false);
    expect(UpdateChatAgentRequestSchema.parse({ baseRevision: 1, recipe: null })).toMatchObject({
      baseRevision: 1,
      recipe: null,
    });
  });

  it("accepts the daily brief recipe without accepting resolved server fields", () => {
    expect(ChatAgentRecipeSchema.parse(recipe)).toEqual(recipe);
    expect(ChatAgentRecipeSchema.safeParse({
      ...recipe,
      skills: [{ id: "matrix-integrations", instructions: "forged", sha256: "0".repeat(64) }],
    }).success).toBe(false);
    expect(ChatAgentRecipeSchema.safeParse({ ...recipe, credentials: { token: "forged" } }).success).toBe(false);
  });

  it("rejects unknown skills and duplicate skill or integration references", () => {
    expect(ChatAgentRecipeSchema.safeParse({ ...recipe, skills: ["matrix-unknown"] }).success).toBe(false);
    expect(ChatAgentRecipeSchema.safeParse({ ...recipe, skills: ["matrix-integrations", "matrix-integrations"] }).success).toBe(false);
    expect(ChatAgentRecipeSchema.safeParse({
      ...recipe,
      integrations: [{ service: "gmail" }, { service: "gmail" }],
    }).success).toBe(false);
    expect(ChatAgentRecipeSchema.safeParse({
      ...recipe,
      integrations: [
        { service: "gmail", accountLabel: "Work" },
        { service: "gmail", accountLabel: " Work " },
      ],
    }).success).toBe(false);
  });

  it("bounds recipe collections, labels, output characters and output bytes", () => {
    expect(ChatAgentRecipeSchema.safeParse({ ...recipe, skills: Array(9).fill("matrix-integrations") }).success).toBe(false);
    expect(ChatAgentRecipeSchema.safeParse({
      ...recipe,
      integrations: Array.from({ length: 9 }, (_, index) => ({ service: `service_${index}` })),
    }).success).toBe(false);
    expect(ChatAgentRecipeSchema.safeParse({
      ...recipe,
      integrations: [{ service: "gmail", accountLabel: " " }],
    }).success).toBe(false);
    expect(ChatAgentRecipeSchema.safeParse({ ...recipe, output: "x".repeat(1_001) }).success).toBe(false);
    expect(ChatAgentRecipeSchema.safeParse({ ...recipe, output: "😀".repeat(1_000) + "x" }).success).toBe(false);
  });

  it("exposes a bounded public catalogue with metadata only", () => {
    expect(ChatAgentRecipeCatalogSchema.parse({
      enabled: true,
      skills: [{ id: "matrix-personal-daily-brief", name: "Personal Daily Brief", description: "Prepare a daily brief." }],
      services: [{ id: "gmail", name: "Gmail" }],
    })).toEqual({
      enabled: true,
      skills: [{ id: "matrix-personal-daily-brief", name: "Personal Daily Brief", description: "Prepare a daily brief." }],
      services: [{ id: "gmail", name: "Gmail" }],
    });
    expect(ChatAgentRecipeCatalogSchema.safeParse({
      enabled: true,
      skills: [],
      services: [{ id: "gmail", name: "Gmail", accounts: [{ token: "secret" }] }],
    }).success).toBe(false);
  });

  it("accepts only bounded server-resolved recipe snapshots in admitted context", () => {
    const resolved = {
      skills: [{
        id: "matrix-personal-daily-brief",
        name: "Personal Daily Brief",
        instructions: "Use the selected read-only integrations.",
        sha256: "a".repeat(64),
      }],
      integrations: recipe.integrations,
      output: recipe.output,
    };
    const context = {
      version: 1,
      requestHash: "b".repeat(64),
      agent: {
        id: "bot_12345678",
        revision: 1,
        name: "Daily brief",
        instructions: "Prepare my day.",
        recipe: resolved,
      },
      chats: [],
    };
    expect(ChatRunContextSchema.parse(context).agent?.recipe).toEqual(resolved);
    expect(ChatRunContextSchema.safeParse({
      ...context,
      agent: { ...context.agent, recipe: { ...resolved, skills: [{ ...resolved.skills[0], instructions: "x".repeat(24 * 1024 + 1) }] } },
    }).success).toBe(false);
    expect(ChatRunContextSchema.safeParse({
      ...context,
      agent: { ...context.agent, recipe },
    }).success).toBe(false);
  });
});
