import { describe, expect, it } from "vitest";
import {
  FundedAiAuthorizationRequestSchema,
  FundedAiAuthorizationResponseSchema,
  FundedAiFinalizationRequestSchema,
  FundedAiGlobalPolicySchema,
  FundedAiOperatorGlobalPolicyUpdateRequestSchema,
  FundedAiOperatorGlobalPolicyResponseSchema,
  FundedAiOperatorRuntimePolicyUpdateRequestSchema,
  FundedAiOperatorRuntimePolicyResponseSchema,
  FundedAiPromotionalGrantResponseSchema,
  FundedAiRuntimeFundingSummaryResponseSchema,
  FundedAiPolicyCheckRequestSchema,
  FundedAiPolicyCheckResponseSchema,
  FundedAiRuntimeCredentialIssueResponseSchema,
  FundedAiSafeErrorSchema,
} from "@matrix-os/contracts";

const now = "2026-08-30T20:00:00.000Z";
const staleAfter = "2026-08-30T20:01:00.000Z";
const expiresAt = "2026-08-30T20:15:00.000Z";
const tokenId = "credential_123";
const credential = `sk-matrix-funded-${tokenId}.${"s".repeat(43)}`;

const policy = {
  enabled: true,
  globalRevision: 4,
  runtimeRevision: 2,
  allowedModelIds: ["anthropic/claude-sonnet-5"],
  monthlyBudgetMicrousd: 1_000_000,
  checkedAt: now,
  staleAfter,
} as const;

const funding = {
  asOf: now,
  periodStart: "2026-08-01T00:00:00.000Z",
  monthlyBudgetMicrousd: 1_000_000,
  settledThisMonthMicrousd: 100_000,
  reservedMicrousd: 200_000,
  reservedThisMonthMicrousd: 200_000,
  promotionalBalanceMicrousd: 600_000,
  addonBalanceMicrousd: 400_000,
  creditBalanceMicrousd: 1_000_000,
  remainingBalanceMicrousd: 800_000,
  remainingBudgetMicrousd: 700_000,
} as const;

describe("funded AI control-plane contracts", () => {
  it("represents a bounded dynamic global policy without credentials", () => {
    const value = {
      enabled: true,
      revision: 4,
      allowedModelIds: ["anthropic/claude-sonnet-5"],
      updatedAt: now,
    } as const;
    expect(FundedAiGlobalPolicySchema.parse(value)).toEqual(value);
    expect(FundedAiGlobalPolicySchema.safeParse({
      ...value,
      allowedModelIds: [value.allowedModelIds[0], value.allowedModelIds[0]],
    }).success).toBe(false);
    expect(FundedAiGlobalPolicySchema.safeParse({ ...value, gatewayToken: "secret" }).success).toBe(false);
  });

  it("issues an opaque short-lived credential with explicit audience and scope", () => {
    const value = {
      contractVersion: 1,
      credential: {
        token: credential,
        tokenId,
        audience: "matrix-funded-relay",
        scope: "ai:invoke",
        issuedAt: now,
        expiresAt,
      },
      identity: {
        ownerId: "user_alice",
        machineId: "machine_123",
        runtimeSlot: "primary",
      },
      policy,
    } as const;
    expect(FundedAiRuntimeCredentialIssueResponseSchema.parse(value)).toEqual(value);
    expect(FundedAiRuntimeCredentialIssueResponseSchema.safeParse({
      ...value,
      credential: { ...value.credential, scope: "admin" },
    }).success).toBe(false);
    expect(FundedAiRuntimeCredentialIssueResponseSchema.safeParse({
      ...value,
      tokenHash: "must-never-leave-the-platform",
    }).success).toBe(false);
    expect(FundedAiRuntimeCredentialIssueResponseSchema.safeParse({
      ...value,
      credential: { ...value.credential, expiresAt: "2026-08-30T22:00:00.000Z" },
    }).success).toBe(false);
  });

  it("authorizes one model and request without accepting caller identity", () => {
    const request = {
      credential,
      requestId: "request_123",
      modelId: "anthropic/claude-sonnet-5",
      maxCostMicrousd: 200_000,
    } as const;
    expect(FundedAiAuthorizationRequestSchema.parse(request)).toEqual(request);
    expect(FundedAiAuthorizationRequestSchema.safeParse({
      ...request,
      ownerId: "user_bob",
      machineId: "machine_other",
    }).success).toBe(false);

    const response = {
      contractVersion: 1,
      authorized: true,
      identity: {
        tokenId,
        ownerId: "user_alice",
        machineId: "machine_123",
        runtimeSlot: "primary",
        audience: "matrix-funded-relay",
        scope: "ai:invoke",
        expiresAt,
      },
      policy,
      funding,
      reservation: {
        reservationId: "reservation_123",
        requestId: request.requestId,
        modelId: request.modelId,
        reservedMicrousd: request.maxCostMicrousd,
        remainingBalanceMicrousd: funding.remainingBalanceMicrousd,
        remainingBudgetMicrousd: funding.remainingBudgetMicrousd,
        periodStart: funding.periodStart,
        expiresAt,
        status: "reserved",
      },
    } as const;
    expect(FundedAiAuthorizationResponseSchema.parse(response)).toEqual(response);
    expect(FundedAiAuthorizationResponseSchema.safeParse({ ...response, token: credential }).success).toBe(false);
  });

  it("checks policy without accepting caller identity, request cost, or exposing funding", () => {
    const request = { credential, modelId: "anthropic/claude-sonnet-5" } as const;
    expect(FundedAiPolicyCheckRequestSchema.parse(request)).toEqual(request);
    expect(FundedAiPolicyCheckRequestSchema.safeParse({ ...request, ownerId: "user_bob" }).success).toBe(false);
    expect(FundedAiPolicyCheckRequestSchema.safeParse({ ...request, maxCostMicrousd: 1 }).success).toBe(false);

    const response = {
      contractVersion: 1,
      authorized: true,
      identity: {
        tokenId,
        ownerId: "user_alice",
        machineId: "machine_123",
        runtimeSlot: "primary",
        audience: "matrix-funded-relay",
        scope: "ai:invoke",
        expiresAt,
      },
      policy,
    } as const;
    expect(FundedAiPolicyCheckResponseSchema.parse(response)).toEqual(response);
    expect(FundedAiPolicyCheckResponseSchema.safeParse({ ...response, funding }).success).toBe(false);
    expect(FundedAiPolicyCheckResponseSchema.safeParse({ ...response, credential }).success).toBe(false);
  });

  it("distinguishes exact completion from conservative post-start finalization", () => {
    const locator = { reservationId: "reservation_123", tokenId } as const;
    expect(FundedAiFinalizationRequestSchema.parse({
      ...locator, mode: "exact", actualCostMicrousd: 42,
    })).toEqual({ ...locator, mode: "exact", actualCostMicrousd: 42 });
    expect(FundedAiFinalizationRequestSchema.parse({
      ...locator, mode: "conservative",
    })).toEqual({ ...locator, mode: "conservative" });
    expect(FundedAiFinalizationRequestSchema.safeParse({
      ...locator, mode: "conservative", actualCostMicrousd: 1,
    }).success).toBe(false);
    expect(FundedAiFinalizationRequestSchema.safeParse({
      ...locator, mode: "exact",
    }).success).toBe(false);
  });

  it("allows only coarse, secret-free control-plane errors", () => {
    expect(FundedAiSafeErrorSchema.safeParse({
      error: { code: "access_disabled", message: "Matrix-funded AI is unavailable" },
    }).success).toBe(true);
    expect(FundedAiSafeErrorSchema.safeParse({
      error: { code: "database_error", message: "postgresql://secret@db.internal" },
    }).success).toBe(false);
  });

  it("returns an identity-free runtime funding summary with authoritative effective policy", () => {
    const response = { contractVersion: 1, funding, policy } as const;
    expect(FundedAiRuntimeFundingSummaryResponseSchema.parse(response)).toEqual(response);
    expect(FundedAiRuntimeFundingSummaryResponseSchema.safeParse({
      ...response,
      ownerId: "user_alice",
    }).success).toBe(false);
    expect(FundedAiRuntimeFundingSummaryResponseSchema.safeParse({
      ...response,
      credential,
    }).success).toBe(false);
    expect(FundedAiRuntimeFundingSummaryResponseSchema.safeParse({
      ...response,
      funding: { ...funding, periodStart: "2026-08-02T00:00:00.000Z" },
    }).success).toBe(false);
    expect(FundedAiRuntimeFundingSummaryResponseSchema.safeParse({
      ...response,
      funding: { ...funding, reservedThisMonthMicrousd: 200_001 },
    }).success).toBe(false);
    expect(FundedAiRuntimeFundingSummaryResponseSchema.safeParse({
      ...response,
      policy: { ...policy, allowedModelIds: ["anthropic/claude-opus-5"] },
    }).success).toBe(true);
    expect(FundedAiRuntimeFundingSummaryResponseSchema.safeParse({
      ...response,
      policy: { ...policy, monthlyBudgetMicrousd: policy.monthlyBudgetMicrousd + 1 },
    }).success).toBe(false);
    expect(FundedAiRuntimeFundingSummaryResponseSchema.safeParse({
      ...response,
      policy: { ...policy, checkedAt: "2026-08-30T20:00:01.000Z" },
    }).success).toBe(false);
  });

  it("projects durable funding shortfall as a contra-credit balance", () => {
    const response = {
      contractVersion: 1,
      funding: {
        ...funding,
        fundingShortfallMicrousd: 150_000,
        remainingBalanceMicrousd: 650_000,
      },
      policy,
    } as const;
    expect(FundedAiRuntimeFundingSummaryResponseSchema.parse(response)).toEqual(response);
    expect(FundedAiRuntimeFundingSummaryResponseSchema.safeParse({
      ...response,
      funding: { ...response.funding, remainingBalanceMicrousd: 800_000 },
    }).success).toBe(false);
  });

  it("keeps operator policy and promotional grant payloads bounded and identity-free", () => {
    const globalRequest = {
      expectedRevision: 4,
      enabled: true,
      allowedModelIds: ["anthropic/claude-sonnet-5"],
    } as const;
    expect(FundedAiOperatorGlobalPolicyUpdateRequestSchema.parse(globalRequest)).toEqual(globalRequest);
    expect(FundedAiOperatorGlobalPolicyUpdateRequestSchema.safeParse({
      ...globalRequest,
      relayToken: "secret",
    }).success).toBe(false);
    expect(FundedAiOperatorGlobalPolicyResponseSchema.parse({
      contractVersion: 1,
      policy: {
        enabled: globalRequest.enabled,
        revision: 5,
        allowedModelIds: globalRequest.allowedModelIds,
        updatedAt: now,
      },
    })).toEqual({
      contractVersion: 1,
      policy: {
        enabled: true,
        revision: 5,
        allowedModelIds: ["anthropic/claude-sonnet-5"],
        updatedAt: now,
      },
    });

    const runtimeRequest = {
      expectedRevision: 2,
      enabled: true,
      allowedModelIds: ["anthropic/claude-sonnet-5"],
      monthlyBudgetMicrousd: 1_000_000,
      expiresAt: "2026-09-30T20:00:00.000Z",
    } as const;
    expect(FundedAiOperatorRuntimePolicyUpdateRequestSchema.parse(runtimeRequest)).toEqual(runtimeRequest);
    expect(FundedAiOperatorRuntimePolicyUpdateRequestSchema.safeParse({
      ...runtimeRequest,
      ownerId: "user_alice",
      machineId: "machine_123",
    }).success).toBe(false);
    const runtimeResponse = {
      contractVersion: 1,
      policy: {
        enabled: true,
        revision: 3,
        allowedModelIds: ["anthropic/claude-sonnet-5"],
        monthlyBudgetMicrousd: 1_000_000,
        expiresAt: runtimeRequest.expiresAt,
        updatedAt: now,
      },
    } as const;
    expect(FundedAiOperatorRuntimePolicyResponseSchema.parse(runtimeResponse)).toEqual(runtimeResponse);
    expect(FundedAiOperatorRuntimePolicyResponseSchema.safeParse({
      ...runtimeResponse,
      ownerId: "user_alice",
    }).success).toBe(false);

    const grantResponse = {
      contractVersion: 1,
      grant: {
        kind: "promotional" as const,
        amountMicrousd: 500_000,
        expiresAt: "2026-09-30T20:00:00.000Z",
        createdAt: now,
        status: "active" as const,
      },
    };
    expect(FundedAiPromotionalGrantResponseSchema.parse(grantResponse)).toEqual(grantResponse);
    expect(FundedAiPromotionalGrantResponseSchema.safeParse({
      ...grantResponse,
      grant: { ...grantResponse.grant, entryId: "machine_123" },
    }).success).toBe(false);
  });
});
