import { describe, expect, it } from "vitest";
import {
  FundedAiAuthorizationRequestSchema, FundedAiAuthorizationResponseSchema,
  FundedAiFinalizationRequestSchema, FundedAiReleaseResponseSchema,
} from "@matrix-os/contracts";

const at = "2026-11-04T12:00:00.000Z";
const funding = { asOf: at, periodStart: "2026-11-01T00:00:00.000Z", monthlyBudgetMicrousd: 1_000_000,
  settledThisMonthMicrousd: 0, reservedMicrousd: 0, reservedThisMonthMicrousd: 0,
  promotionalBalanceMicrousd: 1_000_000, addonBalanceMicrousd: 0, creditBalanceMicrousd: 1_000_000,
  remainingBalanceMicrousd: 1_000_000, remainingBudgetMicrousd: 1_000_000 };
const request = { credential: `sk-matrix-funded-token_123.${"s".repeat(43)}`, requestId: "request_123",
  modelId: "anthropic/claude-sonnet-5", maxCostMicrousd: 200_000,
  billingMode: "usage", billingPolicy: "postpaid" };
const response = { contractVersion: 1, authorized: true,
  identity: { tokenId: "token_123", ownerId: "owner_123", machineId: "machine_123", runtimeSlot: "primary",
    audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-11-04T13:00:00.000Z" },
  policy: { enabled: true, globalRevision: 1, runtimeRevision: 1, allowedModelIds: [request.modelId],
    monthlyBudgetMicrousd: 1_000_000, checkedAt: at, staleAfter: "2026-11-04T12:01:00.000Z" }, funding,
  reservation: { reservationId: "reservation_123", requestId: request.requestId, modelId: request.modelId,
    reservedMicrousd: 0, billingMode: "usage", billingPolicy: "postpaid", maxCostMicrousd: request.maxCostMicrousd,
    remainingBalanceMicrousd: 1_000_000, remainingBudgetMicrousd: 1_000_000,
    periodStart: funding.periodStart, expiresAt: "2026-11-04T12:05:00.000Z", status: "reserved" } };

describe("funded postpaid wire policy", () => {
  it("explicitly authorizes zero customer hold with a separate positive provider ceiling", () => {
    expect(FundedAiAuthorizationRequestSchema.parse(request)).toEqual(request);
    expect(FundedAiAuthorizationResponseSchema.parse(response)).toEqual(response);
  });
  it("does not infer postpaid from zero and rejects contradictory paid-hold captures", () => {
    for (const reservation of [
      { ...response.reservation, billingPolicy: undefined },
      { ...response.reservation, billingMode: undefined },
      { ...response.reservation, reservedMicrousd: 1 },
      { ...response.reservation, maxCostMicrousd: 0 },
    ]) expect(FundedAiAuthorizationResponseSchema.safeParse({ ...response, reservation }).success).toBe(false);
    expect(FundedAiAuthorizationRequestSchema.safeParse({ ...request, billingMode: undefined }).success).toBe(false);
  });
  it("keeps positive legacy usage captures readable without reinterpreting their holds", () => {
    const legacy = { ...response, reservation: { ...response.reservation, billingPolicy: undefined,
      reservedMicrousd: 200_000 } };
    expect(FundedAiAuthorizationResponseSchema.parse(legacy).reservation.reservedMicrousd).toBe(200_000);
  });
  it("carries a trusted exact failure disposition without inventing unknown provider usage", () => {
    const failed = { reservationId: "reservation_123", tokenId: "token_123", mode: "exact",
      actualCostMicrousd: 42, customerCharge: "waived" };
    expect(FundedAiFinalizationRequestSchema.parse(failed)).toEqual(failed);
    expect(FundedAiFinalizationRequestSchema.safeParse({ ...failed, customerCharge: "charge" }).success).toBe(false);
    expect(FundedAiFinalizationRequestSchema.safeParse({ ...failed, mode: "conservative" }).success).toBe(false);
  });
  it("can acknowledge releasing a request that never froze customer credit", () => {
    const released = { contractVersion: 1, reservationId: "reservation_123", requestId: request.requestId,
      tokenId: "token_123", releasedMicrousd: 0, releasedAt: at,
      reason: "pre_upstream_failure", status: "released", funding };
    expect(FundedAiReleaseResponseSchema.parse(released)).toEqual(released);
  });
});
