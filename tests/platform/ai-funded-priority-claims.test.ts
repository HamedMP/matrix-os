import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const modelId = "anthropic/claude-sonnet-5";
const primary = { ownerId: "claims_owner", machineId: "claims_primary", runtimeSlot: "primary" };
const preview = { ownerId: "claims_owner", machineId: "claims_preview", runtimeSlot: "preview" };
type Identity = typeof primary;
type Credential = { token: string; tokenId: string };

describe("funded AI interactive priority claims", () => {
  let db: PlatformDB;
  let clock: Date;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;

  const usage = (credential: Credential, requestId: string, claimKey?: string) => ({
    credential: credential.token, requestId, modelId, maxCostMicrousd: 5_380_000, billingMode: "usage" as const,
    ...(claimKey ? { claimKey } : {}),
  });
  const hold = (credential: Credential, requestId: string) => ({
    credential: credential.token, requestId, modelId, maxCostMicrousd: 100,
  });
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

  async function fundRuntime(target: Identity) {
    await insertUserMachine(db, {
      machineId: target.machineId, clerkUserId: target.ownerId, handle: target.machineId,
      runtimeSlot: target.runtimeSlot, status: "running", imageVersion: "v1",
      provisionedAt: clock.toISOString(), activationState: "authorized",
    });
    await repo.setRuntimePolicy({ identity: target, expectedRevision: 0, enabled: true,
      allowedModelIds: [modelId], monthlyBudgetMicrousd: 10_000_000, expiresAt: null });
    await repo.grantCredit({ entryId: `grant_${target.machineId}`, identity: target,
      kind: "promotional_grant", amountMicrousd: 10_000_000, sourceReference: "test-credit" });
  }

  async function issue(target: Identity, requestClass: "interactive" | "background"): Promise<Credential> {
    return (await repo.issueRuntimeCredential(target, { requestClass })).credential;
  }

  async function finish(authorization: { reservation: { reservationId: string } }, credential: Credential) {
    const key = { reservationId: authorization.reservation.reservationId, tokenId: credential.tokenId };
    await repo.startReservation(key);
    await repo.finalizeReservation({ ...key, mode: "exact", actualCostMicrousd: 1_000 });
  }

  async function claims() {
    return db.executor.selectFrom("ai_funded_priority_claims").selectAll().orderBy("created_at").execute();
  }

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date("2026-09-27T12:00:00.000Z");
    let counter = 0;
    repo = createAiFundedPolicyRepository({ db, credentialHashSecret: "h".repeat(32),
      now: () => new Date(clock), tokenIdFactory: () => `claims_token_${++counter}`,
      tokenSecretFactory: () => "s".repeat(43), credentialTtlMs: 3_600_000,
      issueCooldownMs: 1_000, reservationTtlMs: 300_000, inFlightTtlMs: 60_000 });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await fundRuntime(primary);
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it("issues one credential per class without the cooldown of the other class", async () => {
    const background = await issue(primary, "background");
    const interactive = await issue(primary, "interactive");
    const rows = await db.executor.selectFrom("ai_runtime_credentials").select(["token_id", "request_class"]).orderBy("token_id").execute();
    expect(rows).toEqual([
      { token_id: background.tokenId, request_class: "background" },
      { token_id: interactive.tokenId, request_class: "interactive" },
    ]);
    await expect(issue(primary, "background")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("treats a credential issued without a class as interactive", async () => {
    const legacy = (await repo.issueRuntimeCredential(primary)).credential;
    expect(await db.executor.selectFrom("ai_runtime_credentials").select("request_class")
      .where("token_id", "=", legacy.tokenId).executeTakeFirstOrThrow()).toEqual({ request_class: "interactive" });
  });

  it("commits a claim when an interactive request meets a busy slot", async () => {
    const background = await issue(primary, "background");
    const interactive = await issue(primary, "interactive");
    expect((await repo.authorize(usage(background, "bg_1"))).authorized).toBe(true);

    await expect(repo.authorize(usage(interactive, "turn_1"))).rejects.toMatchObject({ code: "rate_limited", reason: "slot_busy" });

    expect(await claims()).toEqual([expect.objectContaining({
      owner_id: primary.ownerId, machine_id: primary.machineId, runtime_slot: primary.runtimeSlot,
      billing_mode: "usage", created_at: clock.toISOString(), expires_at: new Date(clock.getTime() + 120_000).toISOString(),
    })]);
  });

  it("keeps a freed slot for the waiting interactive runtime, including across relay retries", async () => {
    await fundRuntime(preview);
    const background = await issue(primary, "background");
    const interactive = await issue(primary, "interactive");
    const otherRuntimeBackground = await issue(preview, "background");
    const running = await repo.authorize(usage(background, "bg_1"));
    await expect(repo.authorize(usage(interactive, "turn_attempt_1"))).rejects.toMatchObject({ reason: "slot_busy" });

    await finish(running, background);

    await expect(repo.authorize(usage(background, "bg_2"))).rejects.toMatchObject({ code: "rate_limited", reason: "priority_hold" });
    await expect(repo.authorize(usage(otherRuntimeBackground, "bg_other"))).rejects.toMatchObject({ reason: "priority_hold" });
    // The relay mints a new request id per attempt; the runtime's claim still applies.
    await expect(repo.authorize(usage(interactive, "turn_attempt_2"))).resolves.toMatchObject({ authorized: true });
    expect(await claims()).toEqual([]);
  });

  it("keeps the claim when the interactive credential rotates", async () => {
    const background = await issue(primary, "background");
    const first = await issue(primary, "interactive");
    const running = await repo.authorize(usage(background, "bg_1"));
    await expect(repo.authorize(usage(first, "turn_1"))).rejects.toMatchObject({ reason: "slot_busy" });
    await finish(running, background);
    advance(1_000);
    const rotated = await issue(primary, "interactive");

    await expect(repo.authorize(usage(rotated, "turn_2"))).resolves.toMatchObject({ authorized: true });
    expect(await claims()).toEqual([]);
  });

  it("never extends a claim and releases background work when it expires", async () => {
    const background = await issue(primary, "background");
    const interactive = await issue(primary, "interactive");
    const running = await repo.authorize(usage(background, "bg_1"));
    const claimedAt = clock.toISOString();
    await expect(repo.authorize(usage(interactive, "turn_1"))).rejects.toMatchObject({ reason: "slot_busy" });
    advance(60_000);
    await expect(repo.authorize(usage(interactive, "turn_2"))).rejects.toMatchObject({ reason: "slot_busy" });
    expect(await claims()).toEqual([expect.objectContaining({
      created_at: claimedAt, expires_at: new Date(Date.parse(claimedAt) + 120_000).toISOString(),
    })]);

    await finish(running, background);
    advance(61_000);
    await expect(repo.authorize(usage(background, "bg_after_expiry"))).resolves.toMatchObject({ authorized: true });
  });

  it("serves the oldest waiting runtime first", async () => {
    await fundRuntime(preview);
    const background = await issue(primary, "background");
    const primaryInteractive = await issue(primary, "interactive");
    const previewInteractive = await issue(preview, "interactive");
    const running = await repo.authorize(usage(background, "bg_1"));
    await expect(repo.authorize(usage(previewInteractive, "preview_turn"))).rejects.toMatchObject({ reason: "slot_busy" });
    advance(1_000);
    await expect(repo.authorize(usage(primaryInteractive, "primary_turn"))).rejects.toMatchObject({ reason: "slot_busy" });

    await finish(running, background);

    await expect(repo.authorize(usage(primaryInteractive, "primary_retry"))).rejects.toMatchObject({ reason: "priority_queue" });
    await expect(repo.authorize(usage(previewInteractive, "preview_retry"))).resolves.toMatchObject({ authorized: true });
    expect((await claims()).map((claim) => claim.runtime_slot)).toEqual(["primary"]);
  });

  it("keeps distinct turns on one runtime in their own order", async () => {
    const background = await issue(primary, "background");
    const interactive = await issue(primary, "interactive");
    const running = await repo.authorize(usage(background, "bg_1"));
    await expect(repo.authorize(usage(interactive, "turn_a_1", "run_a"))).rejects.toMatchObject({ reason: "slot_busy" });
    advance(1_000);
    await expect(repo.authorize(usage(interactive, "turn_b_1", "run_b"))).rejects.toMatchObject({ reason: "slot_busy" });
    await finish(running, background);

    await expect(repo.authorize(usage(interactive, "turn_b_2", "run_b"))).rejects.toMatchObject({ reason: "priority_queue" });
    await expect(repo.authorize(usage(interactive, "turn_a_2", "run_a"))).resolves.toMatchObject({ authorized: true });
    expect((await claims()).map((claim) => claim.claim_key)).toEqual(["run_b"]);
  });

  it("puts a runtime in line when an older claim is waiting and the slot is free", async () => {
    await fundRuntime(preview);
    const background = await issue(primary, "background");
    const previewInteractive = await issue(preview, "interactive");
    const primaryInteractive = await issue(primary, "interactive");
    const running = await repo.authorize(usage(background, "bg_1"));
    await expect(repo.authorize(usage(previewInteractive, "preview_turn"))).rejects.toMatchObject({ reason: "slot_busy" });
    await finish(running, background);
    advance(1_000);

    await expect(repo.authorize(usage(primaryInteractive, "primary_turn"))).rejects.toMatchObject({ reason: "priority_queue" });

    expect((await claims()).map((claim) => claim.runtime_slot)).toEqual(["preview", "primary"]);
  });

  it("refuses a seventeenth waiting runtime without writing a claim", async () => {
    const background = await issue(primary, "background");
    const interactive = await issue(primary, "interactive");
    await repo.authorize(usage(background, "bg_1"));
    const expiresAt = new Date(clock.getTime() + 120_000).toISOString();
    await db.executor.insertInto("ai_funded_priority_claims").values(Array.from({ length: 16 }, (_, index) => ({
      owner_id: primary.ownerId, machine_id: `other_machine_${index}`, runtime_slot: "primary",
      billing_mode: "usage", created_at: clock.toISOString(), expires_at: expiresAt,
    }))).execute();

    await expect(repo.authorize(usage(interactive, "turn_1"))).rejects.toMatchObject({ reason: "priority_full" });

    expect((await claims()).some((claim) => claim.machine_id === primary.machineId)).toBe(false);
  });

  it("does not hold background work that would not conflict with the waiting claimant", async () => {
    const background = await issue(primary, "background");
    const interactive = await issue(primary, "interactive");
    const running = await repo.authorize(usage(background, "bg_usage"));
    await expect(repo.authorize(hold(interactive, "turn_hold"))).rejects.toMatchObject({ reason: "slot_busy" });
    expect(await claims()).toEqual([expect.objectContaining({ billing_mode: "hold" })]);
    await finish(running, background);

    await expect(repo.authorize(hold(background, "bg_hold"))).resolves.toMatchObject({ authorized: true });
    await expect(repo.authorize(usage(background, "bg_usage_2"))).rejects.toMatchObject({ reason: "priority_hold" });
  });

  it("deletes expired claims during reservation cleanup and keeps live ones", async () => {
    const insert = (machineId: string, expiresAt: string) => db.executor.insertInto("ai_funded_priority_claims").values({
      owner_id: primary.ownerId, machine_id: machineId, runtime_slot: "primary", billing_mode: "usage",
      created_at: new Date(Date.parse(expiresAt) - 120_000).toISOString(), expires_at: expiresAt,
    }).execute();
    await insert("expired_machine", new Date(clock.getTime() - 1).toISOString());
    await insert("live_machine", new Date(clock.getTime() + 60_000).toISOString());

    await repo.cleanupExpiredReservations({ limit: 10 });

    expect((await claims()).map((claim) => claim.machine_id)).toEqual(["live_machine"]);
  });

  it("upgrades a waiting claim to usage mode without moving it", async () => {
    const background = await issue(primary, "background");
    const interactive = await issue(primary, "interactive");
    const running = await repo.authorize(usage(background, "bg_usage"));
    const claimedAt = clock.toISOString();
    await expect(repo.authorize({ ...hold(interactive, "turn_hold"), claimKey: "run_a" })).rejects.toMatchObject({ reason: "slot_busy" });
    advance(1_000);
    await expect(repo.authorize(usage(interactive, "turn_usage", "run_a"))).rejects.toMatchObject({ reason: "slot_busy" });
    expect(await claims()).toEqual([expect.objectContaining({ claim_key: "run_a", billing_mode: "usage", created_at: claimedAt })]);
    await finish(running, background);

    await expect(repo.authorize(hold(background, "bg_hold"))).rejects.toMatchObject({ reason: "priority_hold" });
  });

  it("does not claim a place for a request it cannot afford", async () => {
    const background = await issue(primary, "background");
    const interactive = await issue(primary, "interactive");
    await repo.authorize(usage(background, "bg_usage"));

    // Beyond the monthly budget even if the active hold were released.
    await expect(repo.authorize({ ...hold(interactive, "turn_too_big"), maxCostMicrousd: 11_000_000 }))
      .rejects.toMatchObject({ code: "budget_exceeded" });

    expect(await claims()).toEqual([]);
  });

  it("replays an authorized request unchanged even while a claim waits", async () => {
    const background = await issue(primary, "background");
    const interactive = await issue(primary, "interactive");
    const running = await repo.authorize(usage(background, "bg_1"));
    await expect(repo.authorize(usage(interactive, "turn_1"))).rejects.toMatchObject({ reason: "slot_busy" });

    await expect(repo.authorize(usage(background, "bg_1"))).resolves.toEqual(running);
  });
});
