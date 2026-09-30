import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapSlackDatabase, type SlackDatabase } from "../../packages/platform/src/slack/database.js";
import { SlackRepository } from "../../packages/platform/src/slack/repository.js";
import { createRealCollaborationTestDatabase } from "../gateway/collaboration-test-support.js";

let db: Kysely<SlackDatabase>;
let repository: SlackRepository;
let clock: Date;
let destroyFixture: (() => Promise<void>) | undefined;
const installation = { appId: "A123", teamId: "T123", organizationId: "org_company", installedBy: "user_admin", botUserId: "UBOT", encryptedBotToken: "encrypted" };
beforeEach(async () => {
  if (process.env.MATRIX_TEST_POSTGRES_URL) {
    const fixture = await createRealCollaborationTestDatabase();
    db = fixture.db as unknown as Kysely<SlackDatabase>; destroyFixture = fixture.destroy;
  } else {
    const instance = await KyselyPGlite.create(); db = new Kysely({ dialect: instance.dialect });
    destroyFixture = () => db.destroy();
  }
  await bootstrapSlackDatabase(db); clock = new Date("2026-09-30T10:00:00Z"); repository = new SlackRepository(db, { now: () => clock });
  await repository.saveInstallation(installation);
});
afterEach(async () => { await destroyFixture?.(); destroyFixture = undefined; });

describe("durable Slack authorization metadata", () => {
  it("prevents workspace takeover across organizations and clears links/challenges/bindings on uninstall", async () => {
    await expect(repository.saveInstallation({ ...installation, organizationId: "org_other" })).rejects.toMatchObject({ code: "conflict" });
    await repository.createChallenge({ hash: "a".repeat(64), appId: "A123", teamId: "T123", slackUserId: "U123" });
    await repository.completeLink({ hash: "a".repeat(64), actorId: "user_employee", organizationId: "org_company" });
    await repository.saveChannelBinding({ ...installation, channelId: "C123", scopeId: "11111111-1111-4111-8111-111111111111", approvedOutput: true, configuredBy: "user_admin" });
    await repository.revokeInstallation("A123", "T123");
    expect((await repository.getInstallation("A123", "T123"))?.encryptedBotToken).toBe("");
    expect(await repository.getLink("A123", "T123", "U123")).toBeNull();
    expect(await repository.getChannelBinding("A123", "T123", "C123")).toBeNull();
    await repository.saveInstallation(installation);
    expect(await repository.getLink("A123", "T123", "U123")).toBeNull();
    expect((await repository.getInstallation("A123", "T123"))?.generation).toBe(3);
  });
  it("makes OAuth consume single-use and fixed expiry with bounded retained metadata", async () => {
    await repository.createOAuthState({ hash: "b".repeat(64), actorId: "user_admin", organizationId: "org_company" });
    await expect(repository.consumeOAuthState("b".repeat(64), "user_other")).rejects.toMatchObject({ code: "conflict" });
    await repository.consumeOAuthState("b".repeat(64), "user_admin");
    await expect(repository.consumeOAuthState("b".repeat(64), "user_admin")).rejects.toMatchObject({ code: "conflict" });
    clock = new Date(clock.getTime() + 601_000); await repository.cleanup();
    expect(await db.selectFrom("slack_oauth_states").selectAll().execute()).toEqual([]);
  });
  it("prevents silently replacing a Slack identity link or connecting it to an unrelated organization", async () => {
    const first = { hash: "c".repeat(64), appId: "A123", teamId: "T123", slackUserId: "U123" };
    await repository.createChallenge(first);
    await expect(repository.completeLink({ hash: first.hash, actorId: "user_employee", organizationId: "org_other" })).rejects.toMatchObject({ code: "forbidden" });
    await repository.completeLink({ hash: first.hash, actorId: "user_employee", organizationId: "org_company" });
    await repository.createChallenge({ ...first, hash: "d".repeat(64) });
    await expect(repository.completeLink({ hash: "d".repeat(64), actorId: "user_other", organizationId: "org_company" })).rejects.toMatchObject({ code: "conflict" });
    expect((await repository.getLink("A123", "T123", "U123"))?.actorId).toBe("user_employee");
  });
  it("leases inbox claims, fences stale workers, and retains completed duplicates for seven days", async () => {
    const key = { appId: "A123", teamId: "T123", eventId: "Ev123" };
    const first = await repository.claimEvent(key, "e".repeat(64));
    expect(first.outcome).toBe("claimed"); expect((await repository.claimEvent(key, "e".repeat(64))).outcome).toBe("busy");
    expect((await repository.claimEvent(key, "f".repeat(64))).outcome).toBe("conflict");
    clock = new Date(clock.getTime() + 5_001);
    const second = await repository.claimEvent(key, "e".repeat(64)); expect(second.outcome).toBe("claimed");
    if (first.outcome !== "claimed" || second.outcome !== "claimed") throw new Error("Expected claims");
    await repository.settleEvent(key, first.leaseToken, true);
    expect((await repository.claimEvent(key, "e".repeat(64))).outcome).toBe("busy");
    await repository.settleEvent(key, second.leaseToken, true);
    expect((await repository.claimEvent(key, "e".repeat(64))).outcome).toBe("completed");
    clock = new Date(clock.getTime() + 8 * 24 * 60 * 60_000); await repository.cleanup();
    expect(await db.selectFrom("slack_event_receipts").selectAll().execute()).toEqual([]);
  });
});

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("Slack repository real PostgreSQL races (16 workers, pool 8)", () => {
  const key = { appId: "A123", teamId: "T123", eventId: "EvConcurrent" };
  const destination = { ownerId: "user_admin", actorId: "user_employee", slackUserId: "U123", organizationId: "org_company",
    channelId: "C123", threadTs: "123.000", eventTs: "123.456", scopeId: "11111111-1111-4111-8111-111111111111", installationGeneration: 1 };
  const contend = <T>(operation: (worker: SlackRepository) => Promise<T>) => Promise.all(Array.from({ length: 16 }, () =>
    operation(new SlackRepository(db, { now: () => clock }))));

  async function completedReceipt() {
    const claim = await repository.claimEvent(key, "a".repeat(64));
    if (claim.outcome !== "claimed") throw new Error("Expected event claim");
    await repository.recordDestination(key, claim.leaseToken, destination);
    await repository.settleEvent(key, claim.leaseToken, true);
  }

  it("admits exactly one worker for an event and rejects a different digest", async () => {
    const results = await contend(worker => worker.claimEvent(key, "a".repeat(64)));
    const winners = results.filter(result => result.outcome === "claimed");
    expect(winners).toHaveLength(1);
    expect(results.filter(result => result.outcome === "busy")).toHaveLength(15);
    expect((await repository.claimEvent(key, "b".repeat(64))).outcome).toBe("conflict");
    const rows = await db.selectFrom("slack_event_receipts").selectAll().execute();
    expect(rows).toHaveLength(1);
    if (winners[0].outcome !== "claimed") throw new Error("Expected winning lease");
    expect(rows[0].lease_token).toBe(winners[0].leaseToken);
  });

  it("fences both stale completion and stale destination writes after lease recovery", async () => {
    const first = await repository.claimEvent(key, "a".repeat(64));
    if (first.outcome !== "claimed") throw new Error("Expected first lease");
    clock = new Date(clock.getTime() + 5_001);
    const recovered = await contend(worker => worker.claimEvent(key, "a".repeat(64)));
    const winners = recovered.filter(result => result.outcome === "claimed");
    expect(winners).toHaveLength(1);
    if (winners[0].outcome !== "claimed") throw new Error("Expected recovered lease");
    const current = winners[0];
    await Promise.all([
      repository.settleEvent(key, first.leaseToken, true),
      expect(repository.recordDestination(key, first.leaseToken, { ...destination, ownerId: "user_stale" })).rejects.toMatchObject({ code: "conflict" }),
      repository.recordDestination(key, current.leaseToken, destination),
    ]);
    const row = await db.selectFrom("slack_event_receipts").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ state: "pending", lease_token: current.leaseToken, destination_owner_id: destination.ownerId });
    expect((await repository.claimEvent(key, "a".repeat(64))).outcome).toBe("busy");
    await repository.settleEvent(key, current.leaseToken, true);
    expect(await repository.getReplyDestination(key)).toEqual({ ...key, ...destination });
    expect((await repository.claimEvent(key, "a".repeat(64))).outcome).toBe("completed");
  });

  it("consumes OAuth state once across concurrent authenticated callbacks", async () => {
    const hash = "e".repeat(64);
    await repository.createOAuthState({ hash, actorId: "user_admin", organizationId: "org_company" });
    const results = await contend(async worker => {
      try { await worker.consumeOAuthState(hash, "user_admin"); return "consumed"; }
      catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "conflict") return "conflict";
        throw error;
      }
    });
    expect(results.filter(result => result === "consumed")).toHaveLength(1);
    expect(results.filter(result => result === "conflict")).toHaveLength(15);
    expect(await repository.getOAuthState(hash)).toBeNull();
    expect(await db.selectFrom("slack_oauth_states").selectAll().execute()).toHaveLength(1);
  });

  it("claims one reply intent and never reclaims prepared or uncertain delivery", async () => {
    await completedReceipt();
    const digest = "f".repeat(64);
    const results = await contend(worker => worker.claimReply(key, digest));
    expect(results.filter(result => result === "claimed")).toHaveLength(1);
    expect(results.filter(result => result === "unknown")).toHaveLength(15);
    expect((await contend(worker => worker.claimReply(key, digest))).every(result => result === "unknown")).toBe(true);
    await repository.settleReply(key, null);
    expect((await contend(worker => worker.claimReply(key, digest))).every(result => result === "unknown")).toBe(true);
    expect(await db.selectFrom("slack_reply_intents").selectAll().execute()).toMatchObject([{ state: "unknown", digest, delivery_ts: null }]);
    expect(await repository.claimReply(key, "0".repeat(64))).toBe("conflict");
  });
});
