import { signSlackBridgeRequest } from "@matrix-os/contracts/slack-bridge";
import { createSlackBridgeRoutes } from "../../packages/gateway/src/startup/slack-bridge.js";
import { bootstrapCompanyBrainDatabase, type CompanyBrainDatabase } from "../../packages/gateway/src/company-brain/database.js";
import { CompanyBrainService } from "../../packages/gateway/src/company-brain/service.js";
import type { Kysely } from "kysely";
import { bootstrapSlackCompanyDatabase, type SlackCompanyDatabase } from "../../packages/gateway/src/slack/database.js";
import { SlackCompanyService } from "../../packages/gateway/src/slack/company-service.js";
import { createSlackCanonicalReaders } from "../../packages/gateway/src/slack/canonical-readers.js";
import { CollaborationChatExecutionAdapter } from "../../packages/gateway/src/collaboration/chat-execution-adapter.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { createSlackThreadResolver } from "../../packages/gateway/src/slack/thread-resolver.js";
import { MATRIX_BOT_SELECTION } from "../../packages/gateway/src/bots/selection.js";
import { SHARED_MATRIX_BOT_ELIGIBILITY } from "../../packages/gateway/src/collaboration/shared-ai-eligibility.js";
import { createCollaborationTestDatabase, createRealCollaborationTestDatabase, type CollaborationTestDatabase, allowAllOrganizationPrecondition, collaborationActors as actors, collaborationIds as ids, collaborationExecutionEligibility } from "./collaboration-test-support.js";
import type { SlackHomeEnvelope } from "../../packages/gateway/src/slack/schemas.js";
const at = new Date("2026-09-30T11:00:00.000Z");
const envelope: SlackHomeEnvelope = { ownerId: actors.owner, organizationId: "org_team", actorId: actors.owner, channelScopeId: ids.scope,
  event: { appId: "A123", teamId: "T123", channelId: "C123", userId: "U123", eventId: "Ev123", ts: "1790766000.000001", kind: "mention", text: "Question" } };
describe("Slack thread creation inherits live Project authority", () => {
  let fixture: CollaborationTestDatabase;
  let authority: CollaborationAuthority;
  const resolve = vi.fn(); const resolveCompanyBot = vi.fn(); const initializeThread = vi.fn();
  beforeEach(async () => {
    vi.resetAllMocks();
    fixture = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealCollaborationTestDatabase() : createCollaborationTestDatabase()); await bootstrapChatDatabase(fixture.db); await bootstrapCollaborationDatabase(fixture.db);
    const repo = new CollaborationRepository(fixture.db, { now: () => at });
    await repo.createDirectScope({ scopeId: ids.scope, ownerId: actors.owner, organizationId: "org_team", kind: "project", resourceId: "company_project", authorityRuntimeId: ids.runtime });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", ids.scope).execute();
    authority = new CollaborationAuthority(repo, { organizationPrecondition: allowAllOrganizationPrecondition, now: () => at });
    resolve.mockResolvedValue({ ref: { kind: "project", projectId: "company_project" }, fingerprint: "a".repeat(64), primaryWorkspaceRoot: "/private/shared_project" });
  });
  afterEach(async () => { await fixture.destroy(); });
  function resolver() { return createSlackThreadResolver({ db: fixture.db, chats: new ChatRepository(fixture.db), authority,
    executionRoots: { resolve }, resolveCompanyBot, initializeThread,
    getEligibility: async () => ({ generation: 1, eligibility: { ...collaborationExecutionEligibility(), matrixBot: SHARED_MATRIX_BOT_ELIGIBILITY } }), now: () => at }); }
  it("creates one owner Chat with Matrix selection and an inherited child, preserving it on replay", async () => {
    const project = await authority.authorize({ scopeId: ids.scope, actorId: actors.owner, action: "read" });
    const first = await resolver()({ envelope, project });
    const second = await resolver()({ envelope, project });
    expect(second).toEqual(first);
    expect(await fixture.db.selectFrom("chats").selectAll().execute()).toHaveLength(1);
    const chat = await fixture.db.selectFrom("chats").selectAll().executeTakeFirstOrThrow();
    expect(chat.project_id).toBe("company_project"); expect(chat.current_selection).toEqual(MATRIX_BOT_SELECTION);
    expect(chat.collaboration).toMatchObject({ scopeId: first.scopeId, executionFenced: true });
    expect(await authority.authorize({ scopeId: first.scopeId, actorId: actors.owner, action: "request_ai" })).toMatchObject({ membershipScopeId: ids.scope });
    expect(await fixture.db.selectFrom("collaboration_members").selectAll().where("scope_id", "=", first.scopeId).execute()).toEqual([]);
    expect(resolveCompanyBot).toHaveBeenCalledWith(expect.objectContaining({ chatId: first.chatId, projectScopeId: ids.scope, projectId: "company_project" }));
  });
  it("passes a verified Slack event through inherited Chat admission, canonical Pi queue and completed output", async()=>{
    const chats=new ChatRepository(fixture.db);
    chats.setSharedAuthorizer((scopeId,actorId,action)=>authority.authorize({scopeId,actorId,action}));
    const db=fixture.db as unknown as Kysely<SlackCompanyDatabase>;
    await bootstrapSlackCompanyDatabase(db);
    const execution=new CollaborationChatExecutionAdapter({repository:chats,commands:{cancel:vi.fn(),retry:vi.fn(),decideApproval:vi.fn()},
      resolveParticipant:async(actorId)=>({actorId,displayName:actorId}),
      resolveEligibility:async(scopeId)=>(await fixture.db.selectFrom("collaboration_scopes").select("execution_eligibility").where("id","=",scopeId).executeTakeFirstOrThrow()).execution_eligibility,
      resolveProviderReadiness:async()=>"ready",resolveCanonicalProviderAuthority:async()=>({driverKind:"matrix_bot",selection:MATRIX_BOT_SELECTION}),
      resolveResourceRevision:async(_scopeId,chatId)=>(await fixture.db.selectFrom("chats").select("revision").where("id","=",chatId).executeTakeFirstOrThrow()).revision,
      resolveExecutionRoot:async()=>({ref:{kind:"project",projectId:"company_project"},fingerprint:"a".repeat(64)}),requestDispatch:async()=>{},now:()=>at});
    const sendReply=vi.fn(async()=>({status:"sent" as const,messageTs:"1790766001.000001"}));
    const brainDb=fixture.db as unknown as Kysely<CompanyBrainDatabase>;
    await bootstrapCompanyBrainDatabase(brainDb);
    const brain=new CompanyBrainService({db:brainDb,ownerId:actors.owner,authority,now:()=>at});
    await brain.publish(ids.scope,actors.owner,{sourceId:"a".repeat(64),audienceScopeId:ids.scope,title:"Launch decision",text:"The launch decision is to ship on Monday",permalink:"https://example.com/launch",sourceUpdatedAt:at.toISOString(),expectedRevision:0});
    const service=new SlackCompanyService({db,ownerId:actors.owner,authority,execution,resolveThread:resolver(),...createSlackCanonicalReaders(fixture.db),sendReply,brain,now:()=>at});
    const inbound={...envelope,event:{...envelope.event,text:"<@UBOT> Summarize the launch decision"}};
    const path="/api/internal/slack/events", token="a".repeat(64), body=JSON.stringify(inbound);
    const signed=await signSlackBridgeRequest({token,path,body,now:at});
    const bridge=createSlackBridgeRoutes({ownerId:actors.owner,token,authority,receive:event=>service.receive(event),now:()=>at});
    const response=await bridge.request(path,{method:"POST",headers:{"content-type":"application/json",...signed},body});
    expect(response.status).toBe(202);
    expect(await fixture.db.selectFrom("chat_queued_turns").selectAll().execute()).toEqual([]);
    await service.drain();
    const queued=await fixture.db.selectFrom("chat_queued_turns").selectAll().executeTakeFirstOrThrow();
    expect(queued.parts).toEqual([{type:"text",text:expect.stringContaining("The launch decision is to ship on Monday")}]);
    const receipt=await db.selectFrom("slack_company_inbox").select("source_proofs").executeTakeFirstOrThrow();
    expect(receipt.source_proofs).toEqual([{scopeId:ids.scope,sourceId:"a".repeat(64),incarnation:expect.stringMatching(/^[a-f0-9-]{36}$/),revision:1}]);
    expect(queued.driver_kind).toBe("matrix_bot");
    expect(queued.requesting_actor_id).toBe(actors.owner);
    expect(queued.execution_root).toEqual({kind:"project",projectId:"company_project"});
    const owner={type:"personal" as const,ownerId:actors.owner};
    const claimed=await chats.claimNextQueuedTurn(owner,{chatId:queued.chat_id,collaborationScopeId:queued.collaboration_scope_id!,turnId:"cturn_slack_e2e",runId:"run_slack_e2e",messageId:"msg_slack_e2e",claimedAt:at.toISOString()});
    expect(claimed?.run.driverKind).toBe("matrix_bot");
    await chats.appendAssistantDelta(owner,{chatId:queued.chat_id,runId:"run_slack_e2e",messageId:"msg_slack_answer",delta:"The company launch is Monday",createdAt:at.toISOString()});
    await chats.finishRun(owner,{chatId:queued.chat_id,runId:"run_slack_e2e",outcome:"completed",completedAt:at.toISOString()});
    await service.drain();
    expect(sendReply).toHaveBeenCalledWith(expect.objectContaining({text:"The company launch is Monday",queuedTurnId:queued.id,runId:"run_slack_e2e"}));
    expect(await service.receive(inbound)).toMatchObject({duplicate:true});
    expect(await fixture.db.selectFrom("chat_queued_turns").selectAll().execute()).toHaveLength(1);
    const followup={...inbound,event:{...inbound.event,eventId:"Ev124",ts:"1790766000.000002",threadTs:inbound.event.ts}};
    await service.receive(followup);await service.drain();
    const next=await fixture.db.selectFrom("chat_queued_turns").selectAll().where("id","!=",queued.id).executeTakeFirstOrThrow();
    await chats.claimNextQueuedTurn(owner,{chatId:next.chat_id,collaborationScopeId:next.collaboration_scope_id!,turnId:"cturn_slack_e2e_2",runId:"run_slack_e2e_2",messageId:"msg_slack_e2e_2",claimedAt:at.toISOString()});
    await chats.appendAssistantDelta(owner,{chatId:next.chat_id,runId:"run_slack_e2e_2",messageId:"msg_slack_answer_2",delta:"Old answer still says Monday",createdAt:at.toISOString()});
    await chats.finishRun(owner,{chatId:next.chat_id,runId:"run_slack_e2e_2",outcome:"completed",completedAt:at.toISOString()});
    await brain.publish(ids.scope,actors.owner,{sourceId:"a".repeat(64),audienceScopeId:ids.scope,title:"Launch decision",text:"The launch decision changed to Tuesday",permalink:"https://example.com/launch",sourceUpdatedAt:at.toISOString(),expectedRevision:1});
    await service.drain();
    expect(sendReply).toHaveBeenCalledTimes(1);
    const stale=await db.selectFrom("slack_company_outbox").select("state").where("run_id","=","run_slack_e2e_2").executeTakeFirstOrThrow();
    expect(stale.state).toBe("failed");
  });

  it("rejects stale project identity and unavailable or mismatched project roots", async () => {
    const project = await authority.authorize({ scopeId: ids.scope, actorId: actors.owner, action: "read" });
    await expect(resolver()({ envelope: { ...envelope, organizationId: "org_other" }, project })).rejects.toMatchObject({ code: "forbidden" });
    resolve.mockResolvedValueOnce({ ref: { kind: "project", projectId: "another_project" }, fingerprint: "a".repeat(64), primaryWorkspaceRoot: "/private/wrong" });
    await expect(resolver()({ envelope, project })).rejects.toMatchObject({ code: "forbidden" });
    expect(await fixture.db.selectFrom("chats").selectAll().execute()).toEqual([]);
  });
});
