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
  it("uses the live default clock and caps outstanding OAuth and private challenges",async()=>{
    const live=new SlackRepository(db);await live.createOAuthState({appId:"A123",hash:"live",actorId:"user_live",organizationId:"org_company"});expect(await live.getOAuthState("live")).not.toBeNull();
    for(let index=0;index<20;index++)await repository.createOAuthState({appId:"A123",hash:`state${index}`,actorId:"user_admin",organizationId:"org_company"});
    await expect(repository.createOAuthState({appId:"A123",hash:"overflow",actorId:"user_admin",organizationId:"org_company"})).rejects.toMatchObject({code:"capacity"});
    for(let index=0;index<10;index++)await repository.createChallenge({hash:`challenge${index}`,appId:"A123",teamId:"T123",slackUserId:"U123"});
    await expect(repository.createChallenge({hash:"overflow",appId:"A123",teamId:"T123",slackUserId:"U123"})).rejects.toMatchObject({code:"capacity"});
  });
  it("keeps retries on the exact private identity and refuses reused, expired or consumed challenges",async()=>{
    const challenge={hash:"a".repeat(64),appId:"A123",teamId:"T123",slackUserId:"U123"};await repository.createChallenge(challenge);await repository.createChallenge(challenge);
    await repository.saveInstallation({...installation,appId:"A999"});await repository.saveInstallation({...installation,teamId:"T999"});
    for(const changed of [{appId:"A999"},{teamId:"T999"},{slackUserId:"U999"}])await expect(repository.createChallenge({...challenge,...changed})).rejects.toMatchObject({code:"conflict"});
    await repository.completeLink({hash:challenge.hash,actorId:"user_employee",organizationId:"org_company"});
    await expect(repository.createChallenge(challenge)).rejects.toMatchObject({code:"expired"});
    await expect(repository.completeLink({hash:challenge.hash,actorId:"user_employee",organizationId:"org_company"})).rejects.toMatchObject({code:"conflict"});
    await repository.createChallenge({...challenge,hash:"b".repeat(64)});clock=new Date(clock.getTime()+601_000);
    await expect(repository.createChallenge({...challenge,hash:"b".repeat(64)})).rejects.toMatchObject({code:"expired"});
    await expect(repository.completeLink({hash:"b".repeat(64),actorId:"user_employee",organizationId:"org_company"})).rejects.toMatchObject({code:"conflict"});
    await expect(repository.completeLink({hash:"missing",actorId:"user_employee",organizationId:"org_company"})).rejects.toMatchObject({code:"conflict"});
    await expect(repository.createChallenge({...challenge,teamId:"T888"})).rejects.toMatchObject({code:"forbidden"});
    await repository.revokeInstallation("A123","T123");await expect(repository.createChallenge(challenge)).rejects.toMatchObject({code:"forbidden"});
  });
  it("refuses replacing the authenticated Matrix account's existing Slack sender",async()=>{
    await repository.createChallenge({hash:"a".repeat(64),appId:"A123",teamId:"T123",slackUserId:"U123"});await repository.completeLink({hash:"a".repeat(64),actorId:"user_employee",organizationId:"org_company"});
    await repository.createChallenge({hash:"b".repeat(64),appId:"A123",teamId:"T123",slackUserId:"U999"});await expect(repository.completeLink({hash:"b".repeat(64),actorId:"user_employee",organizationId:"org_company"})).rejects.toMatchObject({code:"conflict"});
  });
  it("never authorizes incomplete, pending or expired reply destinations",async()=>{
    const key={appId:"A123",teamId:"T123",eventId:"Ev123"},claim=await repository.claimEvent(key,"a".repeat(64));if(claim.outcome!=="claimed")throw new Error("Expected claim");
    expect(await repository.getReplyDestination(key)).toBeNull();await expect(repository.claimReply(key,"b".repeat(64))).rejects.toMatchObject({code:"forbidden"});
    expect(await repository.getSentReply(key)).toBeNull();
    const destination={ownerId:"user_admin",actorId:"user_employee",slackUserId:"U123",organizationId:"org_company",channelId:"D123",threadTs:"123.456",scopeId:null,installationGeneration:1};
    await repository.recordDestination(key,claim.leaseToken,destination);await repository.settleEvent(key,claim.leaseToken,true);
    expect(await repository.getReplyDestination(key)).toEqual({...key,...destination});
    for(const field of ["destination_owner_id","actor_id","slack_user_id","organization_id","channel_id","thread_ts","installation_generation"] as const){
      const original=await db.selectFrom("slack_event_receipts").selectAll().executeTakeFirstOrThrow();await db.updateTable("slack_event_receipts").set({[field]:null}).execute();expect(await repository.getReplyDestination(key)).toBeNull();await db.updateTable("slack_event_receipts").set({[field]:original[field]}).execute();
    }
    clock=new Date(clock.getTime()+8*86400_000);expect(await repository.getReplyDestination(key)).toBeNull();await expect(repository.claimReply(key,"b".repeat(64))).rejects.toMatchObject({code:"forbidden"});await expect(repository.claimReply({...key,eventId:"EvMissing"},"b".repeat(64))).rejects.toMatchObject({code:"forbidden"});
  });
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
    await repository.createOAuthState({ appId: "A123", hash: "b".repeat(64), actorId: "user_admin", organizationId: "org_company" });
    await expect(repository.consumeOAuthState("b".repeat(64), "user_other")).rejects.toMatchObject({ code: "conflict" });
    await repository.consumeOAuthState("b".repeat(64), "user_admin");
    await expect(repository.consumeOAuthState("b".repeat(64), "user_admin")).rejects.toMatchObject({ code: "conflict" });
    clock = new Date(clock.getTime() + 601_000); await repository.cleanup();
    expect(await db.selectFrom("slack_oauth_states").selectAll().execute()).toEqual([]);
  });
  it("revokes app/org OAuth permits without revoking unrelated install attempts",async()=>{
    const pending={appId:"A123",hash:"a".repeat(64),actorId:"user_admin",organizationId:"org_company"};
    await repository.createOAuthState(pending);
    await repository.createOAuthState({...pending,hash:"b".repeat(64),appId:"A999"});
    await repository.createOAuthState({...pending,hash:"c".repeat(64),organizationId:"org_other"});
    await repository.revokeInstallation("A123","T123");
    expect(await repository.getOAuthState(pending.hash)).toBeNull();
    expect(await repository.getOAuthState("b".repeat(64))).toMatchObject({appId:"A999"});
    expect(await repository.getOAuthState("c".repeat(64))).toMatchObject({organizationId:"org_other"});
    await repository.revokeInstallation("A123","T999");
    expect(await repository.getOAuthState("c".repeat(64))).toBeNull();
    expect(await repository.getOAuthState("b".repeat(64))).not.toBeNull();
  });
  it.each(["unconsumed","revoked","app","organization","actor","expired"])("fences callback installation with an exact consumed permit (%s)",async(change)=>{
    const hash="d".repeat(64);
    await repository.createOAuthState({appId:"A123",hash,actorId:"user_admin",organizationId:"org_company"});
    if(change!=="unconsumed") await repository.consumeOAuthState(hash,"user_admin");
    if(change==="revoked") await repository.revokeInstallation("A123","T123");
    if(change==="expired") clock=new Date(clock.getTime()+601_000);
    const mutation=change==="app"?{appId:"A999"}:change==="organization"?{organizationId:"org_other"}:change==="actor"?{installedBy:"user_other"}:{};
    await expect(repository.saveInstallation({...installation,...mutation},{oauthStateHash:hash})).rejects.toMatchObject({code:"conflict"});
    expect(await repository.getInstallation("A123","T123")).toMatchObject({generation:change==="revoked"?2:1,state:change==="revoked"?"revoked":"active"});
  });
  it("upgrades legacy OAuth states fail-closed and commits each new permit once",async()=>{
    await db.schema.dropTable("slack_oauth_states").execute();
    await db.schema.createTable("slack_oauth_states").addColumn("hash","text",c=>c.primaryKey()).addColumn("actor_id","text",c=>c.notNull())
      .addColumn("organization_id","text",c=>c.notNull()).addColumn("expires_at","timestamptz",c=>c.notNull()).addColumn("consumed_at","timestamptz").execute();
    await db.insertInto("slack_oauth_states").values({hash:"e".repeat(64),actor_id:"user_admin",organization_id:"org_company",expires_at:new Date(clock.getTime()+60_000),consumed_at:null} as never).execute();
    await bootstrapSlackDatabase(db);expect(await repository.getOAuthState("e".repeat(64))).toBeNull();
    const hash="f".repeat(64);await repository.createOAuthState({appId:"A123",hash,actorId:"user_admin",organizationId:"org_company"});
    await repository.consumeOAuthState(hash,"user_admin");await repository.saveInstallation(installation,{oauthStateHash:hash});
    await expect(repository.saveInstallation(installation,{oauthStateHash:hash})).rejects.toMatchObject({code:"conflict"});
    expect((await repository.getInstallation("A123","T123"))?.generation).toBe(2);
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
  it.each([false,true])("serializes in-flight callback permits with uninstall without reactivating a workspace (first=%s)",async(first)=>{
    if(first) await db.deleteFrom("slack_installations").execute();
    const hashes=Array.from({length:16},(_,index)=>String(index).padStart(64,"0"));
    for(const hash of hashes){await repository.createOAuthState({appId:"A123",hash,actorId:"user_admin",organizationId:"org_company"});await repository.consumeOAuthState(hash,"user_admin");}
    const save=(hash:string)=>new SlackRepository(db,{now:()=>clock}).saveInstallation(installation,{oauthStateHash:hash});
    const results=await Promise.allSettled([...hashes.slice(0,8).map(save),repository.revokeInstallation("A123","T123"),...hashes.slice(8).map(save)]);
    expect(results[8].status).toBe("fulfilled");
    for(const result of results) if(result.status==="rejected") expect(result.reason).toMatchObject({code:"conflict"});
    const final=await repository.getInstallation("A123","T123");
    if(final) expect(final).toMatchObject({state:"revoked",encryptedBotToken:""});
    expect(await db.selectFrom("slack_oauth_states").selectAll().execute()).toEqual([]);
  });

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
    await repository.createOAuthState({ appId: "A123", hash, actorId: "user_admin", organizationId: "org_company" });
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
