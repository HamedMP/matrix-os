import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiFundedPolicyError,
  createAiFundedPolicyRepository,
} from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import {
  createTestPlatformDb,
  destroyTestPlatformDb,
} from "./platform-db-test-helper.js";

const now = "2026-08-30T20:00:00.000Z";
const models = ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5"];

describe("funded AI policy repository", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: "machine_123",
      clerkUserId: "user_alice",
      handle: "alice",
      runtimeSlot: "primary",
      hetznerServerId: 123,
      publicIPv4: "203.0.113.10",
      status: "running",
      imageVersion: "v1",
      provisionedAt: "2026-08-30T19:00:00.000Z",
      activationState: "authorized",
    });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
    vi.restoreAllMocks();
  });

  function repository(at = now) {
    const tokenIds = ["credential_123", "credential_456"];
    return createAiFundedPolicyRepository({
      db,
      credentialHashSecret: "h".repeat(32),
      now: () => new Date(at),
      tokenIdFactory: () => tokenIds.shift() ?? "credential_fallback",
      tokenSecretFactory: () => "s".repeat(43),
      credentialTtlMs: 15 * 60_000,
      issueCooldownMs: 60_000,
    });
  }

  async function enableRuntime() {
    const repo = repository();
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: models });
    await repo.setRuntimePolicy({
      identity: { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" },
      expectedRevision: 0,
      enabled: true,
      allowedModelIds: [models[0]],
      monthlyBudgetMicrousd: 1_000,
      expiresAt: null,
    });
    await repo.grantCredit({
      entryId: "grant_test", identity: { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" },
      kind: "promotional_grant", amountMicrousd: 1_000, sourceReference: "test-fixture",
    });
    return repo;
  }

  it("seeds a fail-closed global policy and enforces optimistic concurrency", async () => {
    const repo = repository();
    expect(await repo.getGlobalPolicy()).toMatchObject({ enabled: false, revision: 0, allowedModelIds: [] });

    const results = await Promise.allSettled([
      repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [models[0]] }),
      repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [models[1]] }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ code: "revision_conflict" });
    expect(await repo.getGlobalPolicy()).toMatchObject({ enabled: true, revision: 1 });
  });

  it("logs coarse diagnostics and preserves causes for corrupt stored model policy", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const repo = repository();
    const corruptValue = '{"sk-provider-secret-do-not-log"';
    await db.executor.updateTable("ai_funded_global_policy")
      .set({ allowed_model_ids: corruptValue })
      .where("policy_id", "=", "default").execute();

    const syntaxFailure = await repo.getGlobalPolicy().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(syntaxFailure).toMatchObject({
      message: "Invalid funded AI policy model configuration",
      cause: expect.any(SyntaxError),
    });
    expect(errorLog).toHaveBeenCalledWith(
      "[ai-funded-policy] invalid stored model configuration (syntax_error)",
    );

    await db.executor.updateTable("ai_funded_global_policy")
      .set({ allowed_model_ids: JSON.stringify(["model value must not be logged"]) })
      .where("policy_id", "=", "default").execute();
    const schemaFailure = await repo.getGlobalPolicy().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(schemaFailure).toMatchObject({
      message: "Invalid funded AI policy model configuration",
      cause: expect.objectContaining({ name: "ZodError" }),
    });
    expect(errorLog).toHaveBeenCalledWith(
      "[ai-funded-policy] invalid stored model configuration (schema_error)",
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(
      /sk-provider-secret-do-not-log|model value must not be logged/,
    );
  });

  it("binds runtime eligibility to the canonical machine identity", async () => {
    const repo = repository();
    await expect(repo.setRuntimePolicy({
      identity: { ownerId: "user_bob", machineId: "machine_123", runtimeSlot: "primary" },
      expectedRevision: 0,
      enabled: true,
      allowedModelIds: [models[0]],
      monthlyBudgetMicrousd: 1_000,
      expiresAt: null,
    })).rejects.toMatchObject({ code: "identity_mismatch" });
    await expect(repo.setRuntimePolicy({
      identity: { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" },
      expectedRevision: -1,
      enabled: true,
      allowedModelIds: [models[0]],
      monthlyBudgetMicrousd: 1_000,
      expiresAt: "not-a-timestamp",
    })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("stores only a hash and bounds concurrent credential issuance", async () => {
    const repo = await enableRuntime();
    const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" } as const;
    const results = await Promise.allSettled([
      repo.issueRuntimeCredential(identity),
      repo.issueRuntimeCredential(identity),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const issued = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<unknown>;
    expect(issued.value).toMatchObject({
      credential: { token: expect.stringMatching(/^sk-matrix-funded-/), tokenId: "credential_123" },
      identity,
    });

    const rows = await db.executor.selectFrom("ai_runtime_credentials").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain("sk-matrix-funded-");
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "rate_limited" },
    });
  });

  it("authorizes from the token binding and immediately observes revocation and policy changes", async () => {
    const repo = await enableRuntime();
    const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" } as const;
    const issued = await repo.issueRuntimeCredential(identity);
    await expect(repo.authorize({ credential: issued.credential.token, requestId: "request_1", modelId: models[0], maxCostMicrousd: 100 }))
      .resolves.toMatchObject({ authorized: true, identity });

    await repo.revokeRuntimeCredential({ tokenId: issued.credential.tokenId, identity });
    await expect(repo.authorize({ credential: issued.credential.token, requestId: "request_2", modelId: models[0], maxCostMicrousd: 100 }))
      .rejects.toMatchObject({ code: "unauthorized" });

    const nextRepo = createAiFundedPolicyRepository({
      db,
      credentialHashSecret: "h".repeat(32),
      now: () => new Date("2026-08-30T20:02:00.000Z"),
      tokenIdFactory: () => "credential_456",
      tokenSecretFactory: () => "t".repeat(43),
      credentialTtlMs: 15 * 60_000,
      issueCooldownMs: 60_000,
    });
    const second = await nextRepo.issueRuntimeCredential(identity);
    await repo.updateGlobalPolicy({ expectedRevision: 1, enabled: false, allowedModelIds: [] });
    await expect(nextRepo.authorize({ credential: second.credential.token, requestId: "request_3", modelId: models[0], maxCostMicrousd: 100 }))
      .rejects.toMatchObject({ code: "access_disabled" });
  });

  it("rejects expired credentials and models outside the effective intersection", async () => {
    const repo = await enableRuntime();
    const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" } as const;
    const issued = await repo.issueRuntimeCredential(identity);
    await expect(repo.authorize({ credential: issued.credential.token, requestId: "request_4", modelId: models[1], maxCostMicrousd: 100 }))
      .rejects.toMatchObject({ code: "model_not_allowed" });

    const expired = createAiFundedPolicyRepository({
      db,
      credentialHashSecret: "h".repeat(32),
      now: () => new Date("2026-08-30T20:16:00.000Z"),
    });
    await expect(expired.authorize({ credential: issued.credential.token, requestId: "request_5", modelId: models[0], maxCostMicrousd: 100 }))
      .rejects.toBeInstanceOf(AiFundedPolicyError);
    await expect(expired.authorize({ credential: issued.credential.token, requestId: "request_6", modelId: models[0], maxCostMicrousd: 100 }))
      .rejects.toMatchObject({ code: "unauthorized" });
  });

  it("checks the current effective policy without mutating balances or reservations", async () => {
    const repo = await enableRuntime();
    const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" } as const;
    const issued = await repo.issueRuntimeCredential(identity);
    const balanceBefore = await db.executor.selectFrom("ai_funded_runtime_balances")
      .selectAll().where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow();

    await expect(repo.checkPolicy({ credential: issued.credential.token, modelId: models[0] }))
      .resolves.toMatchObject({
        authorized: true,
        identity: { ...identity, tokenId: issued.credential.tokenId },
        policy: { enabled: true, allowedModelIds: [models[0]] },
      });
    await expect(repo.checkPolicy({
      credential: issued.credential.token,
      modelId: models[0],
      maxCostMicrousd: 1,
    } as never)).rejects.toMatchObject({ name: "ZodError" });
    await expect(repo.checkPolicy({ credential: issued.credential.token, modelId: models[1] }))
      .rejects.toMatchObject({ code: "model_not_allowed" });

    const balanceAfter = await db.executor.selectFrom("ai_funded_runtime_balances")
      .selectAll().where("machine_id", "=", identity.machineId).executeTakeFirstOrThrow();
    expect(balanceAfter).toEqual(balanceBefore);
    expect(await db.executor.selectFrom("ai_funded_usage_reservations").select("reservation_id").execute()).toEqual([]);
  });

  it("checks credential, canonical machine binding, and live enablement on every request", async () => {
    const repo = await enableRuntime();
    const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" } as const;
    const issued = await repo.issueRuntimeCredential(identity);

    await expect(repo.checkPolicy({
      credential: `sk-matrix-funded-${issued.credential.tokenId}.${"x".repeat(43)}`,
      modelId: models[0],
    })).rejects.toMatchObject({ code: "unauthorized" });

    await db.executor.updateTable("user_machines").set({ status: "stopped" })
      .where("machine_id", "=", identity.machineId).execute();
    await expect(repo.checkPolicy({ credential: issued.credential.token, modelId: models[0] }))
      .rejects.toMatchObject({ code: "unauthorized" });

    await db.executor.updateTable("user_machines").set({ status: "running" })
      .where("machine_id", "=", identity.machineId).execute();
    await repo.updateGlobalPolicy({ expectedRevision: 1, enabled: false, allowedModelIds: models });
    await expect(repo.checkPolicy({ credential: issued.credential.token, modelId: models[0] }))
      .rejects.toMatchObject({ code: "access_disabled" });

    await repo.updateGlobalPolicy({ expectedRevision: 2, enabled: true, allowedModelIds: models });
    await db.executor.updateTable("ai_funded_runtime_policies")
      .set({ expires_at: "2026-08-30T19:59:59.000Z" })
      .where("machine_id", "=", identity.machineId).execute();
    await expect(repo.checkPolicy({ credential: issued.credential.token, modelId: models[0] }))
      .rejects.toMatchObject({ code: "access_disabled" });

    const expired = createAiFundedPolicyRepository({
      db,
      credentialHashSecret: "h".repeat(32),
      now: () => new Date("2026-08-30T20:16:00.000Z"),
    });
    await expect(expired.checkPolicy({ credential: issued.credential.token, modelId: models[0] }))
      .rejects.toMatchObject({ code: "unauthorized" });
  });
});
