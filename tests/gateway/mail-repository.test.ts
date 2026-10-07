import { mailTestDatabase } from "./mail-test-database.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mailObjectNamespace } from "../../packages/gateway/src/mail/objects.js";
import { MailArchiveRepository } from "../../packages/gateway/src/mail/repository.js";
import { JEV_EMAIL_TRIAGE_ANSWER_IDS, JEV_MODEL_ID } from "@matrix-os/contracts";

describe("shared mail archive", () => {
  let repo: MailArchiveRepository;
  let cleanupDb: () => Promise<void>;
  let clock = new Date("2026-10-07T12:00:00Z");
  const key = { ownerId: "owner", accountId: "account" };
  const source = { ...key, provider: "gmail" as const, connectionId: "conn", email: "a@example.com", group: "personal" as const };
  const message = { ...key, messageId: "msg", threadId: "thread", subject: "A newsletter", sender: "news@example.com", receivedAt: "2026-10-01T00:00:00Z", labels: ["INBOX", "UNREAD"], object: { namespace: mailObjectNamespace("owner", "gmail", "conn"), digest: "b".repeat(64), sizeBytes: 10 } };
  beforeEach(async () => {
    clock = new Date("2026-10-07T12:00:00Z");
    const pg = await mailTestDatabase(); cleanupDb = pg.cleanup;
    repo = new MailArchiveRepository(pg.dialect, { now: () => clock });
    await repo.bootstrap();
    await repo.registerSource(source);
  });
  afterEach(async () => { await repo.destroy(); await cleanupDb(); });
  it("upserts within source identity and accounts quota once", async () => {
    const first = await repo.saveMessage(message);
    const again = await repo.saveMessage(message);
    expect(first).toEqual(again);
    expect((await repo.getSource(key))?.usedBytes).toBe(10);
    await expect(repo.saveMessage({ ...message, ownerId: "other" })).rejects.toThrow();
    await expect(repo.registerSource({ ...source, connectionId: "different" })).rejects.toThrow();
  });
  it("requires exact consumer grant and date range even for guessed IDs", async () => {
    const saved = await repo.saveMessage(message);
    if (saved.kind !== "saved") throw new Error("Expected saved");
    const request = { ...key, appId: "edition", id: saved.message.id };
    await expect(repo.readMessage(request)).rejects.toThrow();
    await repo.grantConsumer({ ...key, appId: "edition", from: "2026-09-01T00:00:00Z", until: "2026-10-31T00:00:00Z" });
    expect((await repo.readMessage(request))?.subject).toBe(message.subject);
    await expect(repo.readMessage({ ...request, ownerId: "other" })).rejects.toThrow();
    await repo.revokeConsumer({ ...key, appId: "edition" });
    await expect(repo.readMessage(request)).rejects.toThrow();
  });
  it("rejects quota overflow without partial writes", async () => {
    await repo.registerSource({ ...source, quotaBytes: 15 });
    await repo.saveMessage(message);
    await expect(repo.saveMessage({ ...message, messageId: "another" })).rejects.toThrow(/quota/i);
    expect(await repo.getStoredMessage({ ...key, messageId: "another" })).toBeNull();
    expect((await repo.getSource(key))?.usedBytes).toBe(10);
  });
  it("label-only updates retain the object; deletion suppression survives replay", async () => {
    await repo.saveMessage(message);
    await repo.updateLabels({ ...key, messageId: "msg", labels: ["UNREAD"] });
    expect((await repo.getStoredMessage({ ...key, messageId: "msg" }))?.object).toEqual(message.object);
    await repo.suppressMessage({ ...key, messageId: "msg" });
    expect(await repo.getStoredMessage({ ...key, messageId: "msg" })).toBeNull();
    expect(await repo.saveMessage(message)).toEqual({ kind: "suppressed" });
    expect((await repo.getSource(key))?.usedBytes).toBe(0);
  });
  it("cursor uses write-statement CAS and string history IDs", async () => {
    expect(await repo.advanceCursor({ ...key, baseRevision: 0, cursor: "18446744073709551615" })).toBe(true);
    expect(await repo.advanceCursor({ ...key, baseRevision: 0, cursor: "stale" })).toBe(false);
    expect((await repo.getSource(key))?.cursor).toBe("18446744073709551615");
  });
  it("coalesces jobs and rejects stale lease holders", async () => {
    const range = { ...key, rangeFrom: "2026-07-01T00:00:00Z", rangeUntil: "2026-10-07T00:00:00Z" };
    const first = await repo.enqueueSync(range);
    expect((await repo.enqueueSync(range)).id).toBe(first.id);
    const claim = await repo.claimSync({ ...key, workerId: "one", leaseMs: 1000 });
    expect(claim).not.toBeNull();
    expect(await repo.claimSync({ ...key, workerId: "two" })).toBeNull();
    clock = new Date(clock.getTime() + 1001);
    const next = await repo.claimSync({ ...key, workerId: "two" });
    expect(next?.token).not.toBe(claim?.token);
    expect(await repo.completeSync({ ...key, token: claim!.token })).toBe(false);
    expect(await repo.completeSync({ ...key, token: next!.token })).toBe(true);
  });
  it("lists only granted accounts and enforces range after an opaque ID lookup", async () => {
    const saved = await repo.saveMessage(message); if (saved.kind !== "saved") throw new Error("Expected saved");
    expect(await repo.listGrantedSources({ ownerId: "owner",appId: "edition" })).toEqual([]);
    await repo.grantConsumer({ ...key,appId: "edition",from: "2026-10-02T00:00:00Z" });
    expect(await repo.getGrantedMessageById({ ownerId: "owner",appId: "edition",id: saved.message.id })).toBeNull();
    expect(await repo.listMessages({ ...key,appId: "edition" })).toEqual([]);
    expect(await repo.listGrantedSources({ ownerId: "owner",appId: "edition" })).toHaveLength(1);
  });
  it("retains classifications and corrections independently and rejects malformed seven-score results", async () => {
    const saved = await repo.saveMessage(message); if (saved.kind !== "saved") throw new Error("Expected saved");
    await repo.grantConsumer({ ...key,appId: "edition" });
    const classification = { fingerprint: message.object.digest,contextKind: "verified" as const,recipe: "email-triage-v1" as const,modelPolicyVersion: "v1",result: { requestId: "jev_req_request_123",recipe: "email-triage-v1" as const,model: JEV_MODEL_ID,latencyMs: 1,answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map(id=>({ id,type: "boolean" as const,probability: 0.5 })) } };
    await repo.saveClassification({ ...key,messageId: "msg",classification });
    expect(await repo.getClassification({ ...key,messageId: "msg",...classification })).toEqual(classification);
    expect(await repo.setCorrection({ ...key,appId: "edition",id: saved.message.id,baseRevision: 1,correction: "not_newsletter" })).toBe(true);
    expect(await repo.setCorrection({ ...key,appId: "edition",id: saved.message.id,baseRevision: 1,correction: "newsletter" })).toBe(false);
    await repo.saveMessage(message);
    expect(await repo.getStoredMessage({ ...key,messageId: "msg" })).toMatchObject({ correction: "not_newsletter",classification });
    await expect(repo.saveClassification({ ...key,messageId: "msg",classification: { ...classification,result: { ...classification.result,answers: [] } } })).rejects.toThrow();
    await repo.suppressMessage({ ...key,messageId: "msg" });
    expect(await repo.getClassification({ ...key,messageId: "msg",...classification })).toBeNull();
    expect(await repo.isSuppressed({ ...key,messageId: "msg" })).toBe(true);
  });
  it("keeps cursor checkpoints on repeat incremental runs and fences released workers", async () => {
    const range = { ...key,rangeFrom: "2026-07-01T00:00:00Z",rangeUntil: "2026-10-07T00:00:00Z" };
    await repo.enqueueSync(range); const lease = await repo.claimSync({ ...key,workerId: "worker" });
    expect(await repo.checkpointSync({ ...key,token: lease!.token,baseRevision: 0,checkpoint: { revision: 1,phase: "history",cursor: "12345678901234567890" } })).toBe(true);
    expect(await repo.checkpointSync({ ...key,token: lease!.token,baseRevision: 0,checkpoint: { revision: 1 } })).toBe(false);
    await repo.releaseSync({ ...key,token: lease!.token });
    expect(await repo.completeSync({ ...key,token: lease!.token })).toBe(false);
    const again = await repo.claimSync({ ...key,workerId: "another" });
    await repo.completeSync({ ...key,token: again!.token });
    expect((await repo.enqueueSync(range)).checkpoint).toMatchObject({ revision: 1,phase: "history",cursor: "12345678901234567890" });
  });
  it("protects referenced or leased objects from GC and permits unreferenced collection", async () => {
    const removed: string[] = [];
    await repo.saveMessage(message); await repo.grantConsumer({ ...key,appId: "edition" });
    const saved = await repo.getStoredMessage({ ...key,messageId: "msg" });
    const lease = await repo.leaseObject({ ...key,appId: "edition",id: saved!.id,leaseMs: 1000 });
    expect(await repo.collectObject(message.object.namespace,message.object.digest,async ()=>{ removed.push("removed"); })).toBe(false);
    await repo.suppressMessage({ ...key,messageId: "msg" });
    expect(await repo.collectObject(message.object.namespace,message.object.digest,async ()=>{ removed.push("removed"); })).toBe(false);
    await repo.releaseObjectLease({ ...message.object,token: lease!.token });
    expect(await repo.collectObject(message.object.namespace,message.object.digest,async ()=>{ removed.push("removed"); })).toBe(true);
    expect(removed).toEqual(["removed"]);
  });
  it("stores exact cleanup plans, coalesces claims, and fences operation CAS by account", async () => {
    const saved = await repo.saveMessage(message); if (saved.kind !== "saved") throw new Error("Expected saved");
    const plan = { ...key,id: "plan-id",binding: "conn",hash: "d".repeat(64),expiresAt: clock.getTime()+600_000,policyVersion: "newsletter-v1",messages: [{ messageId: "msg",contentDigest: message.object.digest,ready: true,category: "newsletter",revision: 1,policyVersion: "newsletter-v1" }] };
    await repo.savePlan(plan);
    expect(await repo.getPlan({ ...key,planId: "plan-id" })).toEqual(plan);
    const claims = await Promise.all([repo.claimOperation(plan),repo.claimOperation(plan)]);
    expect(claims[0].id).toBe(claims[1].id);
    const op = claims[0];
    expect(await repo.transition({ ...key,operationId: op.id,messageId: "msg",from: "planned",next: { messageId: "msg",state: "dispatching",originalInbox: true,labels: ["INBOX"] } })).toBe(true);
    expect(await repo.transition({ ...key,accountId: "different",operationId: op.id,messageId: "msg",from: "dispatching",next: { messageId: "msg",state: "confirmed" } })).toBe(false);
    expect(await repo.getOperation({ ...key,operationId: op.id })).toMatchObject({ plan,entries: [{ state: "dispatching" }] });
    clock = new Date(clock.getTime()+600_001);
    expect(await repo.claimOperation(plan, true)).toMatchObject({ id:op.id,entries:[{ state:"dispatching" }] });
    expect(await repo.claimOperation(plan)).toMatchObject({ id:op.id,entries:[{ state:"dispatching" }] });
    await expect(repo.claimOperation({ ...plan, hash: "e".repeat(64) }, true)).rejects.toThrow();
  });
  it("never creates cleanup operations for existing-only or expired plans", async () => {
    await repo.saveMessage(message);
    const plan = { ...key,id: "not-started",binding: "conn",hash: "d".repeat(64),expiresAt: clock.getTime()+1000,policyVersion: "newsletter-v1",messages: [{ messageId: "msg",contentDigest: message.object.digest,ready: true,category: "newsletter",revision: 1,policyVersion: "newsletter-v1" }] };
    await repo.savePlan(plan);
    await expect(repo.claimOperation(plan,true)).rejects.toThrow();
    clock = new Date(clock.getTime()+1001);
    await expect(repo.claimOperation(plan)).rejects.toThrow();
    await expect(repo.claimOperation(plan,true)).rejects.toThrow();
  });
  it("does not skip tied received timestamps during pagination", async () => {
    await repo.saveMessage(message); await repo.saveMessage({ ...message,messageId: "second" }); await repo.grantConsumer({ ...key,appId: "edition" });
    const first = await repo.listMessages({ ...key,appId: "edition",limit: 1 });
    const second = await repo.listMessages({ ...key,appId: "edition",limit: 1,before: first[0].receivedAt,beforeId: first[0].id });
    expect(second).toHaveLength(1); expect(second[0].id).not.toBe(first[0].id);
  });
  it("rolls back composed source, grants and job setup in one transaction", async () => {
    await expect(repo.withTransaction(async (tx) => {
      await tx.registerSource({ ...source,accountId: "rollback",connectionId: "rollback-connection" });
      await tx.grantConsumer({ ownerId: "owner",accountId: "rollback",appId: "edition" });
      await tx.enqueueSync({ ownerId: "owner",accountId: "rollback",rangeFrom: "2026-07-01T00:00:00Z",rangeUntil: "2026-10-07T00:00:00Z" });
      await tx.destroy(); // A transaction-scoped wrapper must not close its owner.
      throw new Error("simulated setup failure");
    })).rejects.toThrow("simulated setup failure");
    expect(await repo.getSource({ ownerId: "owner",accountId: "rollback" })).toBeNull();
    expect(await repo.getSyncJob({ ownerId: "owner",accountId: "rollback" })).toBeNull();
    expect(await repo.listGrantedSources({ ownerId: "owner",appId: "edition" })).toEqual([]);
  });
  it("uses grant-aware deletion CAS and rejects stale or revoked deletes", async () => {
    const saved = await repo.saveMessage(message); if (saved.kind !== "saved") throw new Error("Expected saved");
    const request = { ...key,appId:"edition",id:saved.message.id,baseRevision:1 };
    await expect(repo.suppressGrantedMessage(request)).rejects.toThrow();
    await repo.grantConsumer({ ...key,appId:"edition" });
    await repo.updateLabels({ ...key,messageId:"msg",labels:[] });
    expect(await repo.suppressGrantedMessage(request)).toBe(false);
    expect(await repo.suppressGrantedMessage({ ...request,baseRevision:2 })).toBe(true);
    await expect(repo.suppressGrantedMessage({ ...request,baseRevision:2 })).rejects.toThrow();
  });
  it("finds older classification backlog after newer rows are complete", async () => {
    await repo.saveMessage(message); await repo.saveMessage({ ...message,messageId:"older",receivedAt:"2026-09-30T00:00:00Z" });
    await expect(repo.listClassificationCandidates({ ...key,appId:"edition",modelPolicyVersion:"v1" })).rejects.toThrow();
    await repo.grantConsumer({ ...key,appId:"edition" });
    const first = await repo.listClassificationCandidates({ ...key,appId:"edition",modelPolicyVersion:"v1",limit:1 });
    expect(first[0].messageId).toBe("older");
    await repo.saveClassification({ ...key,messageId:"older",classification: { fingerprint:message.object.digest,contextKind:"verified",recipe:"email-triage-v1",modelPolicyVersion:"v1",result:{requestId:"jev_req_request_123",recipe:"email-triage-v1",model:JEV_MODEL_ID,latencyMs:1,answers:JEV_EMAIL_TRIAGE_ANSWER_IDS.map(id=>({id,type:"boolean",probability:0.5}))} } });
    expect((await repo.listClassificationCandidates({ ...key,appId:"edition",modelPolicyVersion:"v1" })).map(m=>m.messageId)).toEqual(["msg"]);
  });
  it("preserves corrected content through simultaneous stale corrections", async () => {
    const saved = await repo.saveMessage(message); if (saved.kind !== "saved") throw new Error("Expected saved");
    await repo.grantConsumer({ ...key,appId:"edition" });
    const results = await Promise.all([repo.setCorrection({ ...key,appId:"edition",id:saved.message.id,baseRevision:1,correction:"newsletter" }),repo.setCorrection({ ...key,appId:"edition",id:saved.message.id,baseRevision:1,correction:"not_newsletter" })]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("advances beyond twenty terminal ambiguous classifications without rebilling them", async () => {
    await repo.grantConsumer({ ...key,appId:"edition" });
    for (let i=0;i<21;i++) await repo.saveMessage({ ...message,messageId:`backlog-${i}`,receivedAt:new Date(Date.parse(message.receivedAt)+i*1000).toISOString() });
    const request = { ...key,appId:"edition",modelPolicyVersion:"v1" };
    expect(await repo.listClassificationCandidates(request)).toHaveLength(20);
    for (let i=0;i<20;i++) await repo.recordDeferredClassification({ ...key,messageId:`backlog-${i}`,fingerprint:message.object.digest,contextKind:"verified",modelPolicyVersion:"v1",outcome:i%2 ? "unknown" : "result_expired" });
    expect((await repo.listClassificationCandidates(request)).map(m=>m.messageId)).toEqual(["backlog-20"]);
    expect(await repo.listClassificationCandidates({ ...request,modelPolicyVersion:"v2" })).toHaveLength(20);
    await repo.saveMessage({ ...message,messageId:"backlog-0",object:{ ...message.object,digest:"c".repeat(64) } });
    expect((await repo.listClassificationCandidates(request)).map(m=>m.messageId)).toEqual(["backlog-0","backlog-20"]);
  });
  it("keeps deferred classification idempotent and rejects stale or suppressed content", async () => {
    await repo.saveMessage(message); await repo.grantConsumer({ ...key,appId:"edition" });
    const deferred = { ...key,messageId:"msg",fingerprint:message.object.digest,contextKind:"snippet" as const,modelPolicyVersion:"v1",outcome:"unknown" as const };
    await Promise.all([repo.recordDeferredClassification(deferred),repo.recordDeferredClassification(deferred)]);
    expect(await repo.listClassificationCandidates({ ...key,appId:"edition",modelPolicyVersion:"v1" })).toEqual([]);
    await expect(repo.recordDeferredClassification({ ...deferred,ownerId:"different" })).rejects.toThrow();
    await expect(repo.recordDeferredClassification({ ...deferred,fingerprint:"e".repeat(64) })).rejects.toThrow();
    await expect(repo.recordDeferredClassification({ ...deferred,outcome:"pending" as "unknown" })).rejects.toThrow();
    await repo.suppressMessage({ ...key,messageId:"msg" });
    await expect(repo.recordDeferredClassification(deferred)).rejects.toThrow();
  });
  it("prunes expired leases globally in bounded batches without removing live leases", async () => {
    const old = await repo.leaseImport({ ...key,digest:"c".repeat(64),leaseMs:1000 });
    expect(old.token).toBeTruthy();
    clock=new Date(clock.getTime()+1001);
    await repo.leaseImport({ ...key,digest:"d".repeat(64),leaseMs:1000 });
    expect(await repo.pruneExpiredObjectLeases({limit:1})).toBe(1);
    expect(await repo.pruneExpiredObjectLeases({limit:1})).toBe(0);
    expect(await repo.collectObject(message.object.namespace,"d".repeat(64),async()=>{})).toBe(false);
  });
});
