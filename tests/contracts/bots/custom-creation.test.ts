import { describe, expect, it } from "vitest";
import { CreateManagedCustomBotRequestSchema, RecoverManagedCustomBotRequestSchema } from "@matrix-os/contracts";

const funded = { instanceId: "matrix_pi_default", model: "@cf/zai-org/glm-5.3-flash" };
const subscription = { instanceId: "matrix_chatgpt_plan", model: "gpt-owner", options: [
  { id: "accountId", value: "owner-account" }, { id: "grantRevision", value: "3" },
] };
const input = { clientRequestId: "req_custom_contract", name: "Github helper", instructions: "Use confirmed evidence", selection: funded };

describe("managed custom creation source contract", () => {
  it("requires only a bounded current revision for explicit recovery", () => {
    expect(RecoverManagedCustomBotRequestSchema.parse({ baseRevision: 1 })).toEqual({ baseRevision: 1 });
    for (const body of [{}, { baseRevision: 0 }, { baseRevision: 1.5 }, { baseRevision: Number.MAX_SAFE_INTEGER + 1 },
      { baseRevision: 1, chatId: "chat_chosen" }, { baseRevision: 1, ownerId: "foreign" }]) {
      expect(RecoverManagedCustomBotRequestSchema.safeParse(body).success).toBe(false);
    }
  });
  it.each([funded, { ...funded, options: [] }, subscription])("accepts supported explicit sources without changing their identity", selection => {
    expect(CreateManagedCustomBotRequestSchema.parse({ ...input, selection })).toEqual({ ...input, selection, description: "" });
  });

  it.each([
    { ...funded, instanceId: "matrix_pi_chatgpt_plan" },
    { ...funded, instanceId: "matrix_bot_default", model: "auto" },
    { ...funded, instanceId: "matrix_anthropic_api" },
    { ...funded, instanceId: "codex_default" },
    { ...funded, instanceId: "hermes_default" },
    { ...funded, options: subscription.options },
    { ...funded, options: [{ id: "thinking", value: "high" }] },
    { ...subscription, options: [] },
    { ...subscription, options: [{ id: "accountId", value: "owner-account" }] },
    { ...subscription, options: [...subscription.options, { id: "thinking", value: "high" }] },
  ])("rejects unsupported or source-mismatched selections", selection => {
    expect(CreateManagedCustomBotRequestSchema.safeParse({ ...input, selection }).success).toBe(false);
  });

  it("keeps strict recipe, instruction and server-provenance boundaries for funded creation", () => {
    const recipe = { skills: [], integrations: [], output: "A verified result" };
    expect(CreateManagedCustomBotRequestSchema.safeParse({ ...input, recipe }).success).toBe(true);
    for (const invalid of [
      { ...input, instructions: "   " },
      { ...input, recipe: { ...recipe, output: "   " } },
      { ...input, recipe: { ...recipe, skills: ["matrix-jev-email-triage"] } },
      { ...input, recipeRef: { recipeId: "custom-coordinator", version: "1" } },
      { ...input, ownerId: "another-owner" },
    ]) expect(CreateManagedCustomBotRequestSchema.safeParse(invalid).success).toBe(false);
  });
});
