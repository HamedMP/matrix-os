import { describe, expect, it } from "vitest";
import {
  JEV_EMAIL_TRIAGE_ANSWER_IDS,
  JEV_EMAIL_TRIAGE_RECIPE_ID,
  JEV_MODEL_ID,
  JevEmailTriageResultSchema,
  JevEvaluateRequestSchema,
} from "@matrix-os/contracts";

const probabilities = {
  urgent: 0.81,
  needs_reply: 0.76,
  personal_intro: 0.22,
  investment: 0.03,
  recruiting: 0.09,
  newsletter: 0.11,
  cold_outreach: 0.07,
};

describe("Jev evaluation contracts", () => {
  it("accepts only the server-owned email recipe with bounded state and idempotency", () => {
    expect(JevEvaluateRequestSchema.parse({
      recipe: JEV_EMAIL_TRIAGE_RECIPE_ID,
      state: "From: alice@example.com\nSubject: Can you review this today?",
      idempotencyKey: "gmail:work:thread_abc:sha256_0123456789abcdef",
    })).toEqual({
      recipe: "email-triage-v1",
      state: "From: alice@example.com\nSubject: Can you review this today?",
      idempotencyKey: "gmail:work:thread_abc:sha256_0123456789abcdef",
    });

    for (const request of [
      { recipe: "custom-v1", state: "message", idempotencyKey: "mail:thread:hash" },
      { recipe: JEV_EMAIL_TRIAGE_RECIPE_ID, state: "", idempotencyKey: "mail:thread:hash" },
      { recipe: JEV_EMAIL_TRIAGE_RECIPE_ID, state: "x".repeat(32 * 1024 + 1), idempotencyKey: "mail:thread:hash" },
      { recipe: JEV_EMAIL_TRIAGE_RECIPE_ID, state: "message", idempotencyKey: "../another-owner" },
      { recipe: JEV_EMAIL_TRIAGE_RECIPE_ID, state: "message", idempotencyKey: "mail:thread:hash", model: "other/model" },
      { recipe: JEV_EMAIL_TRIAGE_RECIPE_ID, state: "message", idempotencyKey: "mail:thread:hash", apiKey: "secret" },
    ]) {
      expect(JevEvaluateRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("requires every email-triage probability exactly once and within zero to one", () => {
    const valid = {
      requestId: "jev_req_0123456789abcdef",
      recipe: JEV_EMAIL_TRIAGE_RECIPE_ID,
      model: JEV_MODEL_ID,
      latencyMs: 127,
      answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map((id) => ({ id, type: "boolean", probability: probabilities[id] })),
      usage: { inputTokens: 91, outputTokens: 7 },
      cost: { gatewayUsd: "0.000004" },
    };
    expect(JevEmailTriageResultSchema.parse(valid).answers).toHaveLength(7);

    expect(JevEmailTriageResultSchema.safeParse({ ...valid, answers: valid.answers.slice(1) }).success).toBe(false);
    expect(JevEmailTriageResultSchema.safeParse({ ...valid, answers: [...valid.answers, valid.answers[0]] }).success).toBe(false);
    expect(JevEmailTriageResultSchema.safeParse({
      ...valid,
      answers: valid.answers.map((answer) => answer.id === "urgent" ? { ...answer, probability: 1.01 } : answer),
    }).success).toBe(false);
    expect(JevEmailTriageResultSchema.safeParse({ ...valid, providerMetadata: { credential: "secret" } }).success).toBe(false);
  });
});
