import { describe, expect, it } from "vitest";
import {
  FundedAiAuthorizationRequestSchema,
  FundedAiFinalizationRequestSchema,
  JEV_EMAIL_TRIAGE_ANSWER_IDS,
  JEV_MODEL_ID,
  JevEmailTriageResultSchema,
} from "@matrix-os/contracts";

const pricingVersion = "typesafe-jev-input-2026-09";
const resolvedModel = "jev-1.13.0";
const credential = `sk-matrix-funded-credential_123.${"s".repeat(43)}`;
const jevProvenance = { resolvedModel, pricingVersion };

describe("Jev settlement provenance contracts", () => {
  it("binds a bounded reviewed price version to Jev usage authorization only", () => {
    const jev = {
      credential, requestId: "request_123", modelId: JEV_MODEL_ID,
      maxCostMicrousd: 5_000, billingMode: "usage", jevPricingVersion: pricingVersion,
    };
    expect(FundedAiAuthorizationRequestSchema.safeParse(jev).success).toBe(true);
    expect(FundedAiAuthorizationRequestSchema.safeParse({
      ...jev, modelId: "anthropic/claude-sonnet-5",
    }).success).toBe(false);
    expect(FundedAiAuthorizationRequestSchema.safeParse({
      ...jev, billingMode: undefined,
    }).success).toBe(false);
    expect(FundedAiAuthorizationRequestSchema.safeParse({
      ...jev, jevPricingVersion: "unreviewed-price-version",
    }).success).toBe(false);
  });

  it("accepts a complete Jev provenance pair on exact finalization only", () => {
    const exact = {
      reservationId: "reservation_123", tokenId: "credential_123",
      mode: "exact", actualCostMicrousd: 12, jevProvenance,
    };
    expect(FundedAiFinalizationRequestSchema.safeParse(exact).success).toBe(true);
    expect(FundedAiFinalizationRequestSchema.safeParse({
      ...exact, jevProvenance: { pricingVersion },
    }).success).toBe(false);
    expect(FundedAiFinalizationRequestSchema.safeParse({
      ...exact, jevProvenance: { ...jevProvenance, resolvedModel: "typesafe/jev" },
    }).success).toBe(false);
    expect(FundedAiFinalizationRequestSchema.safeParse({
      ...exact, mode: "conservative", actualCostMicrousd: undefined,
    }).success).toBe(false);
  });

  it("accepts bounded generic upstream provenance on exact finalization only", () => {
    const upstreamProvenance = {
      upstream: "aws_bedrock",
      routeId: "bedrock-eu-primary",
      resolvedModel: "qualified-model",
      inferenceProfile: "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/qualified-model",
      region: "eu-west-1",
      pricingVersion: "aws-bedrock-qualified-2026-10-13",
      providerRequestId: "aws-request-1",
    };
    const exact = {
      reservationId: "reservation_123", tokenId: "credential_123",
      mode: "exact", actualCostMicrousd: 12, upstreamProvenance,
    };
    expect(FundedAiFinalizationRequestSchema.safeParse(exact).success).toBe(true);
    expect(FundedAiFinalizationRequestSchema.safeParse({
      ...exact, upstreamProvenance: { ...upstreamProvenance, accessKeyId: "secret" },
    }).success).toBe(false);
    expect(FundedAiFinalizationRequestSchema.safeParse({
      ...exact, upstreamProvenance: { ...upstreamProvenance, upstream: "unknown" },
    }).success).toBe(false);
    expect(FundedAiFinalizationRequestSchema.safeParse({
      ...exact, mode: "conservative", actualCostMicrousd: undefined,
    }).success).toBe(false);
    expect(FundedAiFinalizationRequestSchema.safeParse({
      ...exact, jevProvenance,
    }).success).toBe(false);
  });

  it("keeps historical Jev results valid and exposes additive provenance without replacing stable model", () => {
    const legacy = {
      requestId: "jev_req_request_123", recipe: "email-triage-v1", model: JEV_MODEL_ID,
      latencyMs: 12,
      answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map((id) => ({ id, type: "boolean", probability: 0.5 })),
      usage: { inputTokens: 275, outputTokens: 20 },
      cost: { gatewayUsd: "0.00001155" },
    };
    expect(JevEmailTriageResultSchema.safeParse(legacy).success).toBe(true);
    expect(JevEmailTriageResultSchema.safeParse({ ...legacy, provenance: jevProvenance }).success).toBe(true);
    expect(JevEmailTriageResultSchema.safeParse({
      ...legacy, provenance: { ...jevProvenance, resolvedModel: "other/model" },
    }).success).toBe(false);
  });
});
