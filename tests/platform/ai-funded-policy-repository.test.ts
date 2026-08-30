import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      expiresAt: null,
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

  it("binds runtime eligibility to the canonical machine identity", async () => {
    const repo = repository();
    await expect(repo.setRuntimePolicy({
      identity: { ownerId: "user_bob", machineId: "machine_123", runtimeSlot: "primary" },
      expectedRevision: 0,
      enabled: true,
      allowedModelIds: [models[0]],
      expiresAt: null,
    })).rejects.toMatchObject({ code: "identity_mismatch" });
    await expect(repo.setRuntimePolicy({
      identity: { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" },
      expectedRevision: -1,
      enabled: true,
      allowedModelIds: [models[0]],
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
    await expect(repo.authorize({ credential: issued.credential.token, modelId: models[0] }))
      .resolves.toMatchObject({ authorized: true, identity });

    await repo.revokeRuntimeCredential({ tokenId: issued.credential.tokenId, identity });
    await expect(repo.authorize({ credential: issued.credential.token, modelId: models[0] }))
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
    await expect(nextRepo.authorize({ credential: second.credential.token, modelId: models[0] }))
      .rejects.toMatchObject({ code: "access_disabled" });
  });

  it("rejects expired credentials and models outside the effective intersection", async () => {
    const repo = await enableRuntime();
    const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" } as const;
    const issued = await repo.issueRuntimeCredential(identity);
    await expect(repo.authorize({ credential: issued.credential.token, modelId: models[1] }))
      .rejects.toMatchObject({ code: "model_not_allowed" });

    const expired = createAiFundedPolicyRepository({
      db,
      credentialHashSecret: "h".repeat(32),
      now: () => new Date("2026-08-30T20:16:00.000Z"),
    });
    await expect(expired.authorize({ credential: issued.credential.token, modelId: models[0] }))
      .rejects.toBeInstanceOf(AiFundedPolicyError);
    await expect(expired.authorize({ credential: issued.credential.token, modelId: models[0] }))
      .rejects.toMatchObject({ code: "unauthorized" });
  });
});
