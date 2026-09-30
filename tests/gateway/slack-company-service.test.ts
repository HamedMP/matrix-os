import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { CompanyBrainService } from "../../packages/gateway/src/company-brain/service.js";
import { bootstrapCompanyBrainDatabase, type CompanyBrainDatabase } from "../../packages/gateway/src/company-brain/database.js";
import type { Kysely } from "kysely";
import { createCollaborationTestDatabase, createRealCollaborationTestDatabase, type CollaborationTestDatabase, allowAllOrganizationPrecondition, collaborationActors as actors, collaborationIds as ids } from "./collaboration-test-support.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapSlackCompanyDatabase, type SlackCompanyDatabase } from "../../packages/gateway/src/slack/database.js";
import { SlackCompanyService, type SlackCompanyOptions } from "../../packages/gateway/src/slack/company-service.js";
import { slackIdentity } from "../../packages/gateway/src/slack/repository.js";
import type { SlackHomeEnvelope } from "../../packages/gateway/src/slack/schemas.js";

const childId = "10000000-0000-4000-8000-000000000002";
const now = new Date("2026-09-30T11:00:00.000Z");
const envelope: SlackHomeEnvelope = { ownerId: actors.owner, organizationId: "org_team", actorId: actors.owner, channelScopeId: ids.scope,
  event: { appId: "A123", teamId: "T123", userId: "U123", channelId: "C123", eventId: "Ev123", ts: "1790766000.000001", text: "Summarize the launch decision", kind: "mention" } };

describe("durable Slack company requests use canonical shared Chat admission", () => {
  let fixture: CollaborationTestDatabase;
  let db: Kysely<SlackCompanyDatabase>;
  let authority: CollaborationAuthority;
  let service: SlackCompanyService;
  let options: SlackCompanyOptions;
  const brain={retrieveForRun:vi.fn(),captureSlackMention:vi.fn(),verifyEvidence:vi.fn()};
  const readThread=vi.fn();
  let completed = false;
  let currentTime=now;
  const submit = vi.fn();
  const sendReply = vi.fn();
  const resolveThread = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks(); completed = false; currentTime=now;
    fixture = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealCollaborationTestDatabase() : createCollaborationTestDatabase());
    await bootstrapChatDatabase(fixture.db); await bootstrapCollaborationDatabase(fixture.db);
    db = fixture.db as unknown as Kysely<SlackCompanyDatabase>;
    await bootstrapSlackCompanyDatabase(db);
    const repository = new CollaborationRepository(fixture.db, { now: () => now });
    await repository.createDirectScope({ scopeId: ids.scope, ownerId: actors.owner, organizationId: "org_team", kind: "project", resourceId: "company_project", authorityRuntimeId: ids.runtime });
    await repository.createDirectScope({ scopeId: childId, ownerId: actors.owner, organizationId: "org_team", kind: "chat", resourceId: ids.chat, authorityRuntimeId: ids.runtime });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", ids.scope).execute();
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared", membership_mode: "inherited", parent_scope_id: ids.scope, execution_generation: 1, execution_eligibility: {} }).where("id", "=", childId).execute();
    authority = new CollaborationAuthority(repository, { now: () => now, organizationPrecondition: allowAllOrganizationPrecondition });
    submit.mockResolvedValue({ request: { id: "qturn_slack_test" } });
    sendReply.mockResolvedValue({ status: "sent", messageTs: "1790766001.000001" });
    resolveThread.mockResolvedValue({ scopeId: childId, chatId: ids.chat, projectScopeId: ids.scope, projectId: "company_project" });
    brain.retrieveForRun.mockResolvedValue({sources:[]}); brain.captureSlackMention.mockResolvedValue({sourceId:"a".repeat(64),revision:1,incarnation:"20000000-0000-4000-8000-000000000001",audienceScopeId:ids.scope});
    brain.verifyEvidence.mockImplementation(async(_scope,_actor,_proofs,beforeRead)=>{await beforeRead?.();return true;});
    readThread.mockResolvedValue({messages:[{ts:envelope.event.ts,text:"Launch on Monday",user:"U123"}]});
    options = { db, ownerId: actors.owner, authority, now: () => currentTime, resolveThread,
      execution: { submit, resourceRevision: async () => "0" },
      readResult: async () => completed ? { status: "completed", requestingActorId: actors.owner, runId: "run_slack_test", text: "Ship <@U123> & <!channel>" } : { status: "pending", requestingActorId: actors.owner },
      sendReply,brain,readThread };
    service=new SlackCompanyService(options);
  });
  afterEach(async () => { await fixture.destroy(); });

  it("commits before acknowledgement, deduplicates retries, and preserves exact thread Chat across restart", async () => {
    expect(await service.receive(envelope)).toMatchObject({ accepted: true });
    expect(await service.receive(envelope)).toMatchObject({ accepted: true, duplicate: true });
    expect(submit).not.toHaveBeenCalled();
    await service.drain();
    await service.drain();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({ actorId: actors.owner, scopeId: childId, membershipScopeId: ids.scope, resourceId: ids.chat, capability: "request_ai" });
    expect(submit.mock.calls[0][1]).toMatchObject({ expectedRevision: "0", text: expect.stringContaining(envelope.event.text) });
    completed = true;
    await service.drain();
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0][0]).toMatchObject({ envelope, scopeId: childId, chatId: ids.chat, queuedTurnId: "qturn_slack_test", runId: "run_slack_test", text: "Ship <@U123> & <!channel>" });
    await service.drain();
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(await db.selectFrom("slack_company_threads").selectAll().execute()).toHaveLength(1);
  });

  it("rejects identity changes, unbound channels and DMs without executing", async () => {
    await service.receive(envelope);
    await expect(service.receive({ ...envelope, actorId: actors.editor })).rejects.toBeDefined();
    await expect(service.receive({ ...envelope, channelScopeId: undefined })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.receive({ ...envelope, event: { ...envelope.event, kind: "direct_message" } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.receive({ ...envelope, organizationId: "org_other" })).rejects.toMatchObject({ code: "forbidden" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("fails closed on a child Chat with another audience or after member revocation", async () => {
    await service.receive(envelope);
    resolveThread.mockResolvedValueOnce({ scopeId: childId, chatId: "wrong_chat", projectScopeId: ids.scope, projectId: "company_project" });
    await service.drain();
    expect(submit).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("holds ambiguous outbound delivery for review and never automatically resends", async () => {
    await service.receive(envelope); await service.drain(); completed = true;
    sendReply.mockResolvedValueOnce({ status: "uncertain" });
    await service.drain(); await service.drain();
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(await db.selectFrom("slack_company_outbox").select("state").executeTakeFirstOrThrow()).toMatchObject({ state: "uncertain" });
  });

  it("indexes explicitly approved company mentions and invalidates pending output after source erasure", async()=>{
    const approved={...envelope,companyPublicationApproved:true as const};
    await service.receive(approved); await service.drain();
    expect(brain.captureSlackMention).toHaveBeenCalledTimes(1);
    expect(brain.captureSlackMention).toHaveBeenCalledWith(ids.scope,childId,actors.owner,expect.objectContaining({approval:{ownerId:actors.owner,organizationId:"org_team",scopeId:ids.scope},text:expect.stringContaining("Launch on Monday")}));
    completed=true;
    brain.verifyEvidence.mockRejectedValueOnce(Object.assign(new Error("removed"),{code:"not_found"}));
    await service.drain();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("does not capture unapproved mentions and keeps the bounded original when thread context is unavailable",async()=>{
    readThread.mockRejectedValueOnce(new Error("Slack context unavailable"));
    await service.receive(envelope);await service.drain();
    expect(brain.captureSlackMention).not.toHaveBeenCalled();
    expect(submit.mock.calls[0][1].text).toContain("Slack thread context unavailable");
  });

  it("retries a durable admission after restart while preserving its exact canonical input",async()=>{
    submit.mockRejectedValueOnce(Object.assign(new Error("Owner binding pending"),{code:"unavailable"}));
    await service.receive(envelope);await service.drain();
    expect(submit).toHaveBeenCalledTimes(1);
    await service.drain();expect(submit).toHaveBeenCalledTimes(1);
    const first=submit.mock.calls[0][1];
    currentTime=new Date(now.getTime()+11_000);
    service=new SlackCompanyService(options);
    await service.drain();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][1]).toEqual(first);
    expect(readThread).toHaveBeenCalledTimes(1);
  });

  it("refreshes only unaccepted conflicting revisions and reconciles an already accepted exact request",async()=>{
    submit.mockRejectedValueOnce(Object.assign(new Error("Revision changed"),{code:"conflict"}));
    const lookup=vi.fn(async()=>null);
    const revision=vi.fn(async()=>"2");
    options={...options,findAcceptedRequest:lookup,execution:{submit,resourceRevision:revision}};
    service=new SlackCompanyService(options);
    await service.receive(envelope);await service.drain();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(revision.mock.calls[0][0]).toMatchObject({capability:"read"});
    currentTime=new Date(now.getTime()+11_000);await service.drain();
    expect(submit.mock.calls[1][1].clientRequestId).toEqual(submit.mock.calls[0][1].clientRequestId);
    expect(submit.mock.calls[1][1].expectedRevision).toBe("2");
    const request=submit.mock.calls[1][1];
    // A lost response can be reconciled from the canonical actor/request identity without submitting again.
    await db.updateTable("slack_company_inbox").set({state:"pending",queued_turn_id:null,lease_until:null}).execute();
    submit.mockRejectedValueOnce(Object.assign(new Error("Response lost"),{code:"conflict"}));
    lookup.mockResolvedValueOnce({queuedTurnId:"qturn_slack_test",payloadHash:slackIdentity(request)} as never);
    await service.drain();
    expect((await db.selectFrom("slack_company_inbox").select("state").executeTakeFirstOrThrow()).state).toBe("accepted");
  });

  it("rechecks a member's actual project grants before final publication",async()=>{
    await fixture.db.insertInto("collaboration_members").values({scope_id:ids.scope,actor_id:actors.editor,organization_id:"org_team",role:"editor",status:"accepted",invitation_id:null,invited_by:actors.owner,accepted_at:now,expires_at:null,joined_at:now,updated_at:now,dispositioned_at:null}).execute();
    options={...options,readResult:async()=>completed?{status:"completed",requestingActorId:actors.editor,runId:"run_member",text:"Decision"}:{status:"pending",requestingActorId:actors.editor}};
    service=new SlackCompanyService(options);
    await service.receive({...envelope,actorId:actors.editor});await service.drain();completed=true;
    await fixture.db.updateTable("collaboration_members").set({status:"revoked"}).where("actor_id","=",actors.editor).execute();
    await service.drain();
    expect(sendReply).not.toHaveBeenCalled();
    expect((await db.selectFrom("slack_company_inbox").select("state").executeTakeFirstOrThrow()).state).toBe("failed");
  });

  it.each([
    {partial:true,messages:[{ts:envelope.event.ts,text:"One page of evidence"}]},
    {partial:false,messages:[{ts:envelope.event.ts,text:"x".repeat(3000)}]},
    {partial:false,messages:Array.from({length:21},()=>({ts:envelope.event.ts,text:"Another message"}))},
    {partial:false,messages:Array.from({length:8},()=>({ts:envelope.event.ts,text:"語".repeat(2000)}))},
  ])("labels provider and locally truncated thread evidence as partial before retrieval and capture %#",async(thread)=>{
    readThread.mockResolvedValue(thread);
    await service.receive({...envelope,companyPublicationApproved:true});await service.drain();
    expect(submit.mock.calls[0][1].text).toContain("Slack thread context is partial");
    expect(brain.captureSlackMention.mock.calls[0][3].text).toContain("Slack thread context is partial");
  });

  it.each([[false,"erase_recreate"],[true,"erase_recreate"],[true,"correct"],[true,"delete"]] as const)
  ("rejects invalidated evidence before pending output or retried dispatch (retry=%s, mutation=%s)",async(retry,mutation)=>{
    const brainDb=fixture.db as unknown as Kysely<CompanyBrainDatabase>;
    await bootstrapCompanyBrainDatabase(brainDb);
    const realBrain=new CompanyBrainService({db:brainDb,authority,ownerId:actors.owner,now:()=>now});
    const source={sourceId:"a".repeat(64),audienceScopeId:ids.scope,title:"Launch decision",text:"Launch decision is Monday",permalink:"https://example.com/launch",sourceUpdatedAt:now.toISOString(),expectedRevision:0};
    await realBrain.publish(ids.scope,actors.owner,source);
    options={...options,brain:realBrain};service=new SlackCompanyService(options);
    if(retry) submit.mockRejectedValueOnce(Object.assign(new Error("Owner initialization pending"),{code:"unavailable"}));
    await service.receive(envelope);await service.drain();expect(submit).toHaveBeenCalledTimes(1);
    if(mutation==="erase_recreate") {
      await realBrain.erase(ids.scope,actors.owner);
      await realBrain.publish(ids.scope,actors.owner,{...source,text:"Replacement decision is Tuesday"});
    } else if(mutation==="correct") await realBrain.publish(ids.scope,actors.owner,{...source,expectedRevision:1,text:"Correction is Tuesday"});
    else await realBrain.remove(ids.scope,actors.owner,source.sourceId,1);
    completed=true;currentTime=new Date(now.getTime()+11_000);await service.drain();
    expect(sendReply).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
    const receipt=await db.selectFrom("slack_company_inbox").select("state").executeTakeFirstOrThrow();
    expect(receipt.state).toBe(retry ? "failed" : "completed");
    if(!retry) expect((await db.selectFrom("slack_company_outbox").select("state").executeTakeFirstOrThrow()).state).toBe("failed");
  });

  it.each([false,true])("revalidates persisted evidence at the final receipt publication boundary (erased=%s)",async(erased)=>{
    const brainDb=fixture.db as unknown as Kysely<CompanyBrainDatabase>;
    await bootstrapCompanyBrainDatabase(brainDb);
    const realBrain=new CompanyBrainService({db:brainDb,authority,ownerId:actors.owner,now:()=>now});
    await realBrain.publish(ids.scope,actors.owner,{sourceId:"a".repeat(64),audienceScopeId:ids.scope,title:"Launch",text:"Launch decision is Monday",permalink:"https://example.com/launch",sourceUpdatedAt:now.toISOString(),expectedRevision:0});
    const actualPublication=vi.fn();
    sendReply.mockImplementation(async(reply)=>{
      // Platform metadata lookup happens after the gateway's first evidence check.
      await Promise.resolve();
      if(erased) await realBrain.erase(ids.scope,actors.owner);
      expect(await service.authorizePublication({organizationId:"org_team",actorId:actors.owner,scopeId:ids.scope,
        appId:"A123",teamId:"T123",eventId:"Ev123",textDigest:createHash("sha256").update(reply.text,"utf8").digest("hex")})).toBe(true);
      actualPublication();return {status:"sent",messageTs:"1790766001.000001"};
    });
    options={...options,brain:realBrain};service=new SlackCompanyService(options);
    await service.receive(envelope);await service.drain();completed=true;await service.drain();
    expect(actualPublication).toHaveBeenCalledTimes(erased?0:1);
    expect((await db.selectFrom("slack_company_outbox").select("state").executeTakeFirstOrThrow()).state).toBe(erased?"failed":"sent");
  });

  it("requires the exact completed receipt, actor, Project and raw canonical text digest for publication",async()=>{
    const publication={organizationId:"org_team",actorId:actors.owner,scopeId:ids.scope,appId:"A123",teamId:"T123",eventId:"Ev123",
      textDigest:createHash("sha256").update("Ship <@U123> & <!channel>","utf8").digest("hex")};
    await expect(service.authorizePublication(publication)).rejects.toMatchObject({code:"forbidden"});
    await service.receive(envelope);await service.drain();
    await expect(service.authorizePublication(publication)).rejects.toMatchObject({code:"forbidden"});
    sendReply.mockImplementation(async()=>{
      for(const mutation of [{organizationId:"org_other"},{actorId:actors.editor},{scopeId:childId},{appId:"A999"},{teamId:"T999"},{eventId:"Ev999"},{textDigest:"b".repeat(64)}]) {
        await expect(service.authorizePublication({...publication,...mutation})).rejects.toMatchObject({code:"forbidden"});
      }
      await expect(service.authorizePublication({...publication,sourceProofs:[]} as never)).rejects.toMatchObject({code:"forbidden"});
      expect(await service.authorizePublication(publication)).toBe(true);
      return {status:"sent",messageTs:"1790766001.000001"};
    });
    completed=true;await service.drain();
    expect((await db.selectFrom("slack_company_outbox").select("state").executeTakeFirstOrThrow()).state).toBe("sent");
    await expect(service.authorizePublication(publication)).rejects.toMatchObject({code:"forbidden"});
  });

  it.each(["changed_text","changed_actor","expired_lease","changed_during_proof_authority"])("fails final publication closed when %s changes while callbacks settle",async(mutation)=>{
    let finalCheck=false;
    let proofAuthoritySettled=false;
    brain.verifyEvidence.mockImplementation(async(_scope,_actor,_proofs,beforeRead)=>{
      if(finalCheck && mutation==="expired_lease") currentTime=new Date(now.getTime()+60_000);
      if(finalCheck) proofAuthoritySettled=true;
      await beforeRead?.();return true;
    });
    options={...options,readResult:async()=>completed?{status:"completed",requestingActorId:finalCheck && mutation==="changed_actor"?actors.editor:actors.owner,
      runId:"run_slack_test",text:finalCheck && (mutation==="changed_text" || (mutation==="changed_during_proof_authority" && proofAuthoritySettled))?"Different canonical result":"Ship <@U123> & <!channel>"}:{status:"pending",requestingActorId:actors.owner}};
    sendReply.mockImplementation(async(reply)=>{
      finalCheck=true;
      await service.authorizePublication({organizationId:"org_team",actorId:actors.owner,scopeId:ids.scope,appId:"A123",teamId:"T123",eventId:"Ev123",
        textDigest:createHash("sha256").update(reply.text,"utf8").digest("hex")});
      throw new Error("Publication should have been denied");
    });
    service=new SlackCompanyService(options);
    await service.receive({...envelope,companyPublicationApproved:true});await service.drain();completed=true;await service.drain();
    expect((await db.selectFrom("slack_company_outbox").select("state").executeTakeFirstOrThrow()).state).toBe("failed");
  });

  it("reacts only after canonical admission and preserves accepted work if the reaction fails",async()=>{
    const onAdmitted=vi.fn(async()=>{
      expect((await db.selectFrom("slack_company_inbox").select("state").executeTakeFirstOrThrow()).state).toBe("accepted");
      throw new Error("Slack reaction unavailable");
    });
    options={...options,onAdmitted};service=new SlackCompanyService(options);
    await service.receive(envelope);expect(onAdmitted).not.toHaveBeenCalled();
    await service.drain();expect(onAdmitted).toHaveBeenCalledWith(envelope);
    expect((await db.selectFrom("slack_company_inbox").select("state").executeTakeFirstOrThrow()).state).toBe("accepted");
  });

  it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("deduplicates concurrent receipts and leases one canonical admission across drainers",async()=>{
    const receipts=await Promise.all(Array.from({length:16},()=>service.receive(envelope)));
    expect(receipts.filter(receipt=>!receipt.duplicate)).toHaveLength(1);
    const restarted=new SlackCompanyService(options);
    await Promise.all([service.drain(),restarted.drain()]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await db.selectFrom("slack_company_inbox").select("id").execute()).toHaveLength(1);
    expect(await db.selectFrom("slack_company_threads").select("thread_key").execute()).toHaveLength(1);
  });

  it("lets a later completed request progress past a full batch of pending results",async()=>{
    submit.mockImplementation(async(_context,request)=>({request:{id:`qturn_${request.clientRequestId}`}}));
    const rows=[];
    for(let index=0;index<21;index++) rows.push(await service.receive({...envelope,event:{...envelope.event,eventId:`EvBATCH${index}`}}));
    await service.drain();await service.drain();await service.drain();
    for(let index=0;index<rows.length;index++) await db.updateTable("slack_company_inbox").set({updated_at:new Date(now.getTime()+index)}).where("id","=",rows[index].eventId).execute();
    const last=rows.at(-1)!.eventId;
    options={...options,readResult:async(input)=>input.queuedTurnId===`qturn_${last}`
      ? {status:"completed",requestingActorId:actors.owner,runId:"run_batch",text:"Latest answer"}
      : {status:"pending",requestingActorId:actors.owner}};
    service=new SlackCompanyService(options);currentTime=new Date(now.getTime()+60_000);
    await service.drain();currentTime=new Date(now.getTime()+61_000);await service.drain();
    expect(sendReply).toHaveBeenCalledWith(expect.objectContaining({runId:"run_batch",text:"Latest answer"}));
  });

  it("suppresses output when requesting authority or canonical actor is stale", async () => {
    await service.receive(envelope); await service.drain(); completed = true;
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "archived" }).where("id", "in", [ids.scope, childId]).execute();
    await service.drain();
    expect(sendReply).not.toHaveBeenCalled();
  });
});
