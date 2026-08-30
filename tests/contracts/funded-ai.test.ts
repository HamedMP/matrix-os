import { describe, expect, it } from "vitest";
import {
  FundedAiAuthorizationRequestSchema,
  FundedAiAuthorizationResponseSchema,
  FundedAiGlobalPolicySchema,
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

  it("allows only coarse, secret-free control-plane errors", () => {
    expect(FundedAiSafeErrorSchema.safeParse({
      error: { code: "access_disabled", message: "Matrix-funded AI is unavailable" },
    }).success).toBe(true);
    expect(FundedAiSafeErrorSchema.safeParse({
      error: { code: "database_error", message: "postgresql://secret@db.internal" },
    }).success).toBe(false);
  });
});
