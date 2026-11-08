import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { canonicalAssistantContinuationId } from "@matrix-os/contracts";
import { createRealBotStateDatabase, OWNER } from "./bot-state-support.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
import { scope } from "./routine-cli-request-support.js";
let data: Awaited<ReturnType<typeof createRealBotStateDatabase>>, f: Awaited<ReturnType<typeof proposalFixture>>;
beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required");
  data = await createRealBotStateDatabase(url, { routineAuthority: true }); f = await proposalFixture(data.db, vi.fn);
});
afterEach(async () => { await f?.close(); await data?.destroy(); });
it("pins initial activation to the exact immutable accepted request, independently of standing approval replacement", async () => {
  await f.submit(); await f.canonical.drain();
  const interaction = await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  await f.interactions.resolve(OWNER, interaction.chat_id, interaction.interaction_id, { kind: "approval", decision: "approve", baseRevision: 1 });
  const routine = await f.db.selectFrom("bot_routines").selectAll().executeTakeFirstOrThrow();
  expect(routine).toMatchObject({ origin_computer_id: scope.computerId, origin_request_id: "de000000-0000-4000-8000-000000000100" });
  const edit = await f.approvals.requestEdit(OWNER, routine.routine_id, { baseRevision: 1, name: "Edited", prompt: "Edited prompt", schedule: { kind: "interval", everyMs: 60_000 } });
  await f.interactions.resolve(OWNER, interaction.chat_id, edit.interaction.interactionId, { kind: "approval", decision: "approve", baseRevision: 1 });
  expect(await f.db.selectFrom("bot_routines").selectAll().executeTakeFirstOrThrow()).toMatchObject({ origin_computer_id: scope.computerId, origin_request_id: routine.origin_request_id, revision: "2", approval_id: edit.interaction.interactionId });
});
it("presents the canonical pending interaction at its real source message without requiring the expired source tool grant", async () => {
  const { admitFixtureRun, originService } = await import("./routine-chat-origin-support.js");
  await admitFixtureRun(f); await f.submit(); await f.canonical.drain(); f.state.live = false;
  const service = originService(f), pending = await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  expect(await service.read(OWNER, "chat_source")).toMatchObject({ sourceChatId: "chat_source", pending: [{ sourceChatId: "chat_source", anchorMessageId: "msg_run_source", interaction: { interactionId: pending.interaction_id, chatId: pending.chat_id, taskId: pending.task_id } }] });
  await service.close();
});
it("resolves the same canonical approval once, preserving duplicate/stale and source privacy boundaries", async () => {
  const { admitFixtureRun, originService, decisionProof } = await import("./routine-chat-origin-support.js");
  await admitFixtureRun(f); await f.submit(); await f.canonical.drain();
  const service = originService(f), interaction = await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  const request = { kind: "approval" as const, baseRevision: 1, decision: "approve" as const }, proof = decisionProof(f, interaction.interaction_id);
  const [first, duplicate] = await Promise.all([service.resolve(OWNER,"chat_source",interaction.interaction_id,request,proof), service.resolve(OWNER,"chat_source",interaction.interaction_id,request,proof)]);
  expect(first.response).toEqual(duplicate.response);
  expect(await f.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(1);
  await expect(service.resolve(OWNER,"chat_other",interaction.interaction_id,request,proof)).rejects.toThrow();
  await expect(service.resolve(OWNER,"chat_source",interaction.interaction_id,{ ...request, baseRevision: 7 },proof)).rejects.toThrow();
  await f.db.updateTable("chats").set({ lifecycle: "archived" }).where("id", "=", "chat_source").execute();
  await expect(service.resolve(OWNER,"chat_source",interaction.interaction_id,request,proof)).rejects.toThrow();
  expect((await f.db.selectFrom("bot_routines").selectAll().execute())[0].status).toBe("active"); await service.close();
});
it("waits for committed output then projects exactly once across restart while foreground Run/provider binding stay untouched and unread advances", async () => {
  const { terminalFixtureFire, originService, admitFixtureRun } = await import("./routine-chat-origin-support.js");
  const fire = await terminalFixtureFire(f), service = originService(f);
  await admitFixtureRun(f,"chat_source","run_foreground");
  const owner = { type: "personal" as const, ownerId: OWNER }, before = (await f.chats.get(owner,"chat_source"))!;
  expect(before.activeRun?.runId).toBe("run_foreground");
  await service.reconcile(OWNER,"chat_source");
  expect((await service.read(OWNER,"chat_source")).deliveryPending).toBe(true);
  expect(await f.db.selectFrom("routine_chat_deliveries").selectAll().execute()).toHaveLength(0);
  await fire.finish(); await service.close();
  const restarted = originService(f);
  await Promise.all([restarted.reconcile(OWNER,"chat_source"),restarted.reconcile(OWNER,"chat_source")]);
  const after = (await f.chats.get(owner,"chat_source"))!;
  expect(after.activeRun).toEqual(before.activeRun); expect(after.providerBinding).toEqual(before.providerBinding);
  expect(after.chat.messageCount).toBe(before.chat.messageCount + 1); expect(after.chat.revision).toBe(before.chat.revision + 1);
  expect(after.readState?.unread).toBe(true);
  const deliveries = await f.db.selectFrom("routine_chat_deliveries").selectAll().execute(); expect(deliveries).toHaveLength(1);
  const message = await f.db.selectFrom("chat_messages").selectAll().where("id","=",deliveries[0].message_id).executeTakeFirstOrThrow();
  expect(message).toMatchObject({ role:"system",run_id:null,turn_id:null,state:"committed" });
  expect(message.parts).toContainEqual(expect.objectContaining({ type:"routine_receipt",canonicalMessageId:"msg_fire_output",canonicalRunId:"run_fire" }));
  expect(await f.db.selectFrom("chat_outbox").selectAll().where("chat_id","=","chat_source").where("event_type","=","chat.updated").execute()).toHaveLength(1);
  await restarted.reconcile(OWNER,"chat_source"); expect((await restarted.read(OWNER,"chat_source")).deliveryPending).toBe(false); expect(await f.db.selectFrom("routine_chat_deliveries").selectAll().execute()).toHaveLength(1); await restarted.close();
});
it.each(["cancelled", "uncertain"] as const)("preserves %s status without claiming worker exit and delivers a separately committed late output once", async status => {
  const { terminalFixtureFire, originService } = await import("./routine-chat-origin-support.js");
  const fire = await terminalFixtureFire(f,status), service = originService(f);
  await service.reconcile(OWNER,"chat_source");
  expect(await f.db.selectFrom("routine_chat_deliveries").selectAll().execute()).toMatchObject([{ kind:"status",receipt:{status:status==="uncertain"?"unknown":status,...(status==="cancelled"?{stop:"unconfirmed"}:{})} }]);
  await fire.finish(); await service.reconcile(OWNER,"chat_source");
  const delivered = await f.db.selectFrom("routine_chat_deliveries").selectAll().orderBy("kind").execute(); expect(delivered).toHaveLength(2);
  expect(delivered[0]).toMatchObject({kind:"output",receipt:{status:status==="uncertain"?"unknown":status,canonicalMessageId:"msg_fire_output"}});
  await service.close();
});
it("filters exact source association before the pending page limit", async () => {
  const { admitFixtureRun, originService } = await import("./routine-chat-origin-support.js");
  await admitFixtureRun(f); await f.submit(); await f.canonical.drain();
  const original = await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  // Stored historical/imported rows can exceed today's repository owner cap; none belongs to this source.
  for (let i=0;i<33;i++) await f.db.insertInto("bot_interactions").values({ ...original, interaction_id:`in_unrelated_${i.toString().padStart(8,"0")}`,blocking:false,created_at:new Date(Date.parse(f.state.clock)+1).toISOString() }).execute();
  const service = originService(f); expect((await service.read(OWNER,"chat_source")).pending.map(item=>item.interaction.interactionId)).toEqual([original.interaction_id]); await service.close();
});
it("fences new decisions after close and drains a decision already waiting on the source transaction", async () => {
  const { admitFixtureRun, originService, decisionProof } = await import("./routine-chat-origin-support.js");
  await admitFixtureRun(f); await f.submit(); await f.canonical.drain();
  const service=originService(f), interaction=await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  let acquired!:()=>void, release!:()=>void; const locked=new Promise<void>(done=>{acquired=done;}), held=new Promise<void>(done=>{release=done;});
  const blocker=f.db.transaction().execute(async tx=>{await tx.selectFrom("chats").select("id").where("id","=","chat_source").forUpdate().execute();acquired();await held;});
  await locked;
  const decision=service.resolve(OWNER,"chat_source",interaction.interaction_id,{kind:"approval",baseRevision:1,decision:"approve"},decisionProof(f,interaction.interaction_id));
  const decisionOutcome=decision.then(()=>"resolved",()=>"refused");
  try {
  // PostgreSQL lock observation, not elapsed-time guessing.
  await expect.poll(async()=>{const {sql}=await import("kysely");return Number((await sql<{n:string}>`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%chats%' AND pid<>pg_backend_pid()`.execute(f.db)).rows[0].n);}).toBeGreaterThan(0);
  let settled=false; const closing=service.close().then(()=>{settled=true;}); await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
  await expect(service.read(OWNER,"chat_source")).rejects.toThrow();
  await expect(service.resolve(OWNER,"chat_source",interaction.interaction_id,{kind:"approval",baseRevision:1,decision:"approve"},decisionProof(f,interaction.interaction_id))).rejects.toThrow();
  release(); await blocker; expect(await decisionOutcome).toBe("refused"); await closing;
  expect(await f.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(0);
  } finally { release(); await blocker; await decisionOutcome; await service.close(); }
});
it.each(["source shared", "source archived", "target shared", "target removed"] as const)("serializes %s winning the decision privacy race", async mode => {
  const { admitFixtureRun, originService, decisionProof } = await import("./routine-chat-origin-support.js");
  await admitFixtureRun(f); await f.submit(); await f.canonical.drain();
  const service=originService(f), interaction=await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  let acquired!:()=>void, release!:()=>void; const locked=new Promise<void>(done=>{acquired=done;}), held=new Promise<void>(done=>{release=done;});
  const blocker=f.db.transaction().execute(async tx=>{
    if(mode==="target removed") await tx.updateTable("bot_chat_bindings").set({removed_at:f.state.clock}).where("chat_id","=",interaction.chat_id).execute();
    else await tx.updateTable("chats").set(mode.endsWith("shared")?{collaboration:{mode:"shared"}}:{lifecycle:"archived"}).where("id","=",mode.startsWith("source")?"chat_source":interaction.chat_id).execute();
    acquired();await held;
  }); await locked;
  const outcome=service.resolve(OWNER,"chat_source",interaction.interaction_id,{kind:"approval",baseRevision:1,decision:"approve"},decisionProof(f,interaction.interaction_id)).then(()=>"resolved",()=>"refused");
  try {
    await expect.poll(async()=>{const {sql}=await import("kysely");return Number((await sql<{n:string}>`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND pid<>pg_backend_pid()`.execute(f.db)).rows[0].n);}).toBeGreaterThan(0);
    release();await blocker;expect(await outcome).toBe("refused");expect(await f.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(0);
  } finally { release();await blocker;await outcome;await service.close(); }
});
it("retains original source across default changes and edit approval while fresh tools remain unauthorized", async()=>{
  const {admitFixtureRun,originService,decisionProof}=await import("./routine-chat-origin-support.js");
  await admitFixtureRun(f);await f.submit();await f.canonical.drain();await f.switchDefault();
  const service=originService(f), initial=(await service.read(OWNER,"chat_source")).pending[0].interaction;
  await service.resolve(OWNER,"chat_source",initial.interactionId,{kind:"approval",baseRevision:1,decision:"approve"},decisionProof(f,initial.interactionId));
  const routine=await f.db.selectFrom("bot_routines").selectAll().executeTakeFirstOrThrow();
  const edit=await f.approvals.requestEdit(OWNER,routine.routine_id,{baseRevision:1,name:"Changed",prompt:"Changed prompt",schedule:{kind:"interval",everyMs:60_000}});
  f.state.live=false;
  expect((await service.read(OWNER,"chat_source")).pending.map(item=>item.interaction.interactionId)).toEqual([edit.interaction.interactionId]);
  await service.resolve(OWNER,"chat_source",edit.interaction.interactionId,{kind:"approval",baseRevision:1,decision:"approve"},decisionProof(f,edit.interaction.interactionId));
  await expect(f.execute({operation:"list"})).rejects.toThrow();
  const {createBotRoutineManagement}=await import("../../../packages/gateway/src/bots/routine-management.js");
  expect((await createBotRoutineManagement(f.db,f.approvals).detail(OWNER,routine.routine_id,true)).routine).toMatchObject({chatId:initial.chatId,originChatId:"chat_source",originAvailable:true});
  await f.db.updateTable("chats").set({lifecycle:"archived"}).where("id","=","chat_source").execute();
  expect((await createBotRoutineManagement(f.db,f.approvals).detail(OWNER,routine.routine_id,true)).routine).toMatchObject({originChatId:"chat_source",originAvailable:false,status:"active"});await service.close();
});
it("keeps legacy strict Schedule list and detail parsers compatible while negotiated clients see the origin", async () => {
  const { terminalFixtureFire } = await import("./routine-chat-origin-support.js");
  const { createBotRoutineRoutes } = await import("../../../packages/gateway/src/bots/routine-routes.js");
  const { createBotRoutineManagement } = await import("../../../packages/gateway/src/bots/routine-management.js");
  const { BotRoutineCenterItemSchema, BotRoutineCenterResponseSchema, BotRoutineDetailResponseSchema } = await import("@matrix-os/contracts");
  const { routine } = await terminalFixtureFire(f);
  const management = createBotRoutineManagement(f.db, f.approvals);
  const app = createBotRoutineRoutes({ getPrincipal: () => f.principal, routines: {
    ...management, list: async () => [], control: async () => { throw new Error("Unexpected control"); },
  } });
  const legacyItem = BotRoutineCenterItemSchema.omit({ originChatId: true, originAvailable: true });
  const legacyCenter = BotRoutineCenterResponseSchema.extend({ items: legacyItem.array() });
  const legacyDetail = BotRoutineDetailResponseSchema.extend({ routine: legacyItem });
  const list = "/api/bot-routines", detail = `${list}/${routine.routine_id}`;
  const read = async (path: string, accept?: string) => {
    const response = await app.request(path, accept ? { headers: { Accept: accept } } : undefined);
    expect(response.status).toBe(200);
    return response.json();
  };

  expect(legacyCenter.parse(await read(list)).items).toHaveLength(1);
  expect(legacyDetail.parse(await read(detail)).routine).toMatchObject({ routineId: routine.routine_id });
  const accept = "application/json; matrix-routine-origin=1";
  expect(BotRoutineCenterResponseSchema.parse(await read(`${list}?archived=false`, accept)).items)
    .toMatchObject([{ originChatId: "chat_source", originAvailable: true }]);
  expect(BotRoutineDetailResponseSchema.parse(await read(detail, accept)).routine)
    .toMatchObject({ originChatId: "chat_source", originAvailable: true });
  expect(legacyDetail.parse(await read(`${detail}?originVersion=0`, accept)).routine).toMatchObject({ routineId: routine.routine_id });
  expect(BotRoutineCenterResponseSchema.parse(await read(`${list}?archived=false&originVersion=1`)).items)
    .toMatchObject([{ originChatId: "chat_source", originAvailable: true }]);
  expect(BotRoutineDetailResponseSchema.parse(await read(`${detail}?originVersion=1`)).routine)
    .toMatchObject({ originChatId: "chat_source", originAvailable: true });
  expect((await app.request(`${list}?originVersion=2`)).status).toBe(400);
  expect((await app.request(`${detail}?originVersion=1&originVersion=1`)).status).toBe(400);
});
it("rolls source delivery claim, append, sequence, revision, unread and outbox back together, then safely recovers", async()=>{
  const {terminalFixtureFire,originService}=await import("./routine-chat-origin-support.js");const fire=await terminalFixtureFire(f);await fire.finish();
  const before=await f.chats.get({type:"personal",ownerId:OWNER},"chat_source");
  await expect(f.chats.withTransaction(async tx=>{await tx.appendRoutineReceipt(OWNER,{sourceChatId:"chat_source",computerId:scope.computerId,fireId:fire.fireId,kind:"output",now:f.state.clock});throw new Error("Fixture rollback");})).rejects.toThrow("Fixture rollback");
  expect(await f.chats.get({type:"personal",ownerId:OWNER},"chat_source")).toEqual(before);
  expect(await f.db.selectFrom("routine_chat_deliveries").selectAll().execute()).toHaveLength(0);
  const service=originService(f);service.start();await expect.poll(async()=>(await f.db.selectFrom("routine_chat_deliveries").selectAll().execute()).length).toBe(1);await service.close();
  expect(await f.db.selectFrom("chat_outbox").selectAll().where("chat_id","=","chat_source").where("event_type","=","chat.updated").execute()).toHaveLength(1);
});
it.each(["source shared","target shared","source deleted"] as const)("suppresses delivery after %s while canonical fire/history survive",async mode=>{
  const {terminalFixtureFire,originService}=await import("./routine-chat-origin-support.js");const fire=await terminalFixtureFire(f);await fire.finish();
  if(mode==="source deleted")await f.db.deleteFrom("chats").where("id","=","chat_source").execute();
  else await f.db.updateTable("chats").set({collaboration:{mode:"shared"}}).where("id","=",mode.startsWith("source")?"chat_source":fire.routine.chat_id).execute();
  const service=originService(f);await service.reconcile(OWNER,"chat_source");
  expect(await f.db.selectFrom("routine_chat_deliveries").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_routine_fires").select("status").execute()).toEqual([{status:"completed"}]);
  expect(await f.db.selectFrom("chat_messages").select("id").where("id","=","msg_fire_output").execute()).toHaveLength(1);await service.close();
});
it.each(["source", "target"] as const)("suppresses delayed output when the %s Chat was published through a project", async which => {
  const { terminalFixtureFire, originService } = await import("./routine-chat-origin-support.js");
  const { createProjectInheritanceResolver } = await import("../../../packages/gateway/src/collaboration/project-inheritance.js");
  const { reconcileProjectMembershipAtPublication } = await import("../../../packages/gateway/src/collaboration/project-membership-transition.js");
  type CollaborationDb = import("../../../packages/gateway/src/collaboration/database.js").OwnerCollaborationDatabase;
  const db = f.db as unknown as import("kysely").Kysely<CollaborationDb>;
  const fire = await terminalFixtureFire(f); await fire.finish();
  const chatId = which === "source" ? "chat_source" : fire.routine.chat_id;
  const projectScopeId = "10000000-0000-4000-8000-000000000b93", runtimeId = "vps:routine_origin_test";
  await db.insertInto("collaboration_scopes").values({
    id: projectScopeId, owner_type: "personal", owner_id: OWNER, organization_id: "org_scope_test",
    kind: "project", resource_id: "project_scope_test", parent_scope_id: null, membership_mode: "direct",
    lifecycle: "preparing", revision: 1, auth_epoch: 1, authority_runtime_id: runtimeId, authority_generation: 1,
    created_at: f.state.clock, updated_at: f.state.clock, deleted_at: null,
  }).execute();
  await createProjectInheritanceResolver({ db }).bindOwnedResource({
    projectScopeId, ownerId: OWNER, kind: "chat", resourceId: chatId, authorityRuntimeId: runtimeId,
    authorityGeneration: 1, revision: 1, readiness: "ready",
  });
  await db.transaction().execute(async tx => {
    await tx.selectFrom("collaboration_scopes").select("id").where("id", "=", projectScopeId).forUpdate().executeTakeFirstOrThrow();
    await reconcileProjectMembershipAtPublication(tx, { projectScopeId, ownerType: "personal", ownerId: OWNER,
      requestedBy: OWNER, destinationAuthorityRuntimeId: runtimeId, destinationAuthorityGeneration: 1, now: new Date(f.state.clock),
      createEventId: () => "60000000-0000-4000-8000-000000000b93" });
    await tx.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", projectScopeId).execute();
  });
  expect(await db.selectFrom("chats").select("collaboration").where("id", "=", chatId).executeTakeFirstOrThrow()).toEqual({ collaboration: null });
  expect(await db.selectFrom("collaboration_scopes").select("lifecycle").where("kind", "=", "chat").where("resource_id", "=", chatId).executeTakeFirstOrThrow()).toEqual({ lifecycle: "shared" });

  const service = originService(f);
  try {
    await service.reconcile(OWNER, "chat_source");
    // The locked repository is the authority even if a candidate was already selected before publication.
    await expect(f.chats.appendRoutineReceipt(OWNER, {
      sourceChatId: "chat_source", computerId: scope.computerId, fireId: fire.fireId, kind: "output", now: f.state.clock,
    })).resolves.toBeNull();
    if (which === "source") await expect(service.read(OWNER, "chat_source")).rejects.toMatchObject({ code: "not_found" });
    else expect(await service.read(OWNER, "chat_source")).toMatchObject({ deliveryPending: false });
    expect(await f.db.selectFrom("routine_chat_deliveries").select("fire_id").execute()).toEqual([]);
    expect(await f.db.selectFrom("chat_messages").select("id").where("id", "=", "msg_fire_output").execute()).toHaveLength(1);
    expect(await f.db.selectFrom("chat_messages").select("id").where("chat_id", "=", "chat_source").where("role", "=", "system").execute()).toEqual([]);
  } finally { await service.close(); }
});
it.each(["owner","computer","target","source kind"] as const)("rejects forged %s origin links without presenting payload",async mode=>{
  const {admitFixtureRun,originService,decisionProof}=await import("./routine-chat-origin-support.js");await admitFixtureRun(f);await f.submit();await f.canonical.drain();
  const service=originService(f), interaction=await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  if(mode==="target")await f.db.updateTable("routine_cli_requests").set({target_snapshot:{botId:"bot_abcdefgh",chatId:"chat_target_b",ownerId:OWNER,computerId:scope.computerId,preferenceRevision:1}}).execute();
  if(mode==="source kind"){const row=await f.db.selectFrom("routine_cli_requests").select("source_context").executeTakeFirstOrThrow();await f.db.updateTable("routine_cli_requests").set({source_context:{...row.source_context,identity:{kind:"terminal_launch",sessionId:"s",incarnationId:"i",launchId:"l"}}}).execute();}
  const proof=decisionProof(f,interaction.interaction_id);
  if(mode==="computer")proof.machineId="other-machine";
  await expect(service.resolve(mode==="owner"?"other-owner":OWNER,"chat_source",interaction.interaction_id,{kind:"approval",baseRevision:1,decision:"approve"},proof)).rejects.toThrow();
  expect(await f.db.selectFrom("bot_routines").selectAll().execute()).toHaveLength(0);await service.close();
});
it("allows owner source deletion after delivery while preserving canonical routine and output history",async()=>{
  const {terminalFixtureFire,originService}=await import("./routine-chat-origin-support.js");const fire=await terminalFixtureFire(f);await fire.finish();const service=originService(f);await service.reconcile(OWNER,"chat_source");
  expect(await f.db.selectFrom("routine_chat_deliveries").selectAll().execute()).toHaveLength(1);
  await expect(f.db.deleteFrom("chats").where("id","=","chat_source").execute()).resolves.toBeDefined();
  expect(await f.db.selectFrom("bot_routines").select("status").execute()).toEqual([{status:"active"}]);
  expect(await f.db.selectFrom("chat_messages").select("id").where("id","=","msg_fire_output").execute()).toHaveLength(1);await service.close();
});
it("keeps one failed projection visible without starving a later ready delivery or replaying execution",async()=>{
  const {terminalFixtureFire,admitFixtureRun,machine}=await import("./routine-chat-origin-support.js");const first=await terminalFixtureFire(f);await first.finish();
  const run=await admitFixtureRun(f,first.routine.chat_id,"run_second_fire");
  const {createBotTasksRepository}=await import("../../../packages/gateway/src/bots/repositories/tasks.js");const tasks=createBotTasksRepository(f.db);
  const task=await tasks.create({ownerId:OWNER,botId:first.routine.bot_id,chatId:first.routine.chat_id,now:f.state.clock});
  await tasks.transition({ownerId:OWNER,taskId:task.taskId,baseRevision:1,to:"running",runId:run.run.id,now:f.state.clock});
  const secondId="fire_"+"d".repeat(24), at=new Date(Date.parse(f.state.clock)+1).toISOString();
  await f.db.insertInto("bot_routine_fires").values({fire_id:secondId,owner_id:OWNER,routine_id:first.routine.routine_id,task_id:task.taskId,scheduled_for:at,status:"completed",attempts:1,retry_after:null,lease_expires_at:null,failure_code:null,created_at:at,updated_at:at}).execute();
  const detail=(await f.chats.get({type:"personal",ownerId:OWNER},first.routine.chat_id))!;
  await f.chats.finishRun({type:"personal",ownerId:OWNER},{chatId:first.routine.chat_id,runId:run.run.id,outcome:"completed",completedAt:at,output:{id:"msg_second_fire_output",chatId:first.routine.chat_id,seq:detail.chat.messageCount+1,runId:run.run.id,turnId:run.turn.id,role:"assistant",state:"committed",parts:[{type:"text",text:"Second output"}],createdAt:at}});
  const {createRoutineChatOriginService}=await import("../../../packages/gateway/src/bots/routine-chat-origin.js");
  const service=createRoutineChatOriginService({db:f.db,transact:f.transact,interactions:f.interactions,computerId:scope.computerId,expectedMachine:machine,now:()=>new Date(f.state.clock),chats:{appendRoutineReceipt:async(owner,input)=>{if(input.fireId===first.fireId)throw new Error("Fixture projection unavailable");return f.chats.appendRoutineReceipt(owner,input);}}});
  await expect(service.reconcile(OWNER,"chat_source")).rejects.toThrow();
  expect(await f.db.selectFrom("routine_chat_deliveries").select("fire_id").execute()).toEqual([{fire_id:secondId}]);
  expect(await f.db.selectFrom("bot_routine_fires").select("status").execute()).toEqual([{status:"completed"},{status:"completed"}]);await service.close();
});
async function driftBinding(chatId: string, mode: "replacement binding" | "ambiguous binding") {
  const binding = await f.db.selectFrom("bot_chat_bindings").selectAll().where("chat_id", "=", chatId).executeTakeFirstOrThrow();
  if (mode === "replacement binding") {
    await f.db.updateTable("bot_chat_bindings").set({created_at: new Date(Date.parse(f.state.clock) + 10_000).toISOString()})
      .where("chat_id", "=", chatId).execute();
  } else {
    await f.db.insertInto("bot_chat_bindings").values({...binding, bot_id: "bot_deadbeef", kind: "group"}).execute();
  }
}
it.each(["replacement binding", "ambiguous binding"] as const)("refuses source approval against a %s", async mode => {
  const {admitFixtureRun, originService, decisionProof} = await import("./routine-chat-origin-support.js");
  await admitFixtureRun(f); await f.submit(); await f.canonical.drain();
  const interaction = await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  await driftBinding(interaction.chat_id, mode);
  const service = originService(f);
  try {
    await expect(service.resolve(OWNER,"chat_source",interaction.interaction_id,{kind:"approval",baseRevision:1,decision:"approve"},decisionProof(f,interaction.interaction_id))).rejects.toThrow();
    expect((await service.read(OWNER,"chat_source")).pending).toEqual([]);
  } finally { await service.close(); }
});
it.each(["replacement binding", "ambiguous binding"] as const)("suppresses source delivery against a %s", async mode => {
  const {terminalFixtureFire, originService} = await import("./routine-chat-origin-support.js");
  const fire = await terminalFixtureFire(f); await fire.finish(); await driftBinding(fire.routine.chat_id, mode);
  const service = originService(f);
  try {
    await service.wake();
    expect(await f.db.selectFrom("routine_chat_deliveries").select("message_id").execute()).toEqual([]);
    expect((await service.read(OWNER, "chat_source")).deliveryPending).toBe(false);
  } finally { await service.close(); }
});
it("recovery advances past a full unprojectable page and retries it after wraparound", async () => {
  const {terminalFixtureFire, machine} = await import("./routine-chat-origin-support.js");
  const {insertFire} = await import("./routine-cli-request-support.js");
  const {createRoutineChatOriginService} = await import("../../../packages/gateway/src/bots/routine-chat-origin.js");
  const first = await terminalFixtureFire(f, "cancelled");
  for (let n=0; n<33; n++) await insertFire(f.db, first.routine.routine_id, n+1, "cancelled");
  let skip = true;
  const lastId = "fire_" + (33).toString(16).padStart(24,"0");
  const service = createRoutineChatOriginService({db:f.db, transact:f.transact, interactions:f.interactions, computerId:scope.computerId, expectedMachine:machine,
    chats:{appendRoutineReceipt: async (owner,input) => skip && input.fireId !== lastId ? null : f.chats.appendRoutineReceipt(owner,input)}});
  try {
    await service.wake(); await service.wake();
    expect(await f.db.selectFrom("routine_chat_deliveries").select("fire_id").execute()).toEqual([{fire_id:lastId}]);
    skip=false;
    for (let pass=0; pass<4; pass++) await service.wake();
    expect(await f.db.selectFrom("routine_chat_deliveries").select("fire_id").execute()).toHaveLength(34);
  } finally { await service.close(); }
});
it("redacts credentials split across committed output parts before durable source projection", async () => {
  const {terminalFixtureFire, originService} = await import("./routine-chat-origin-support.js");
  const fire = await terminalFixtureFire(f), service = originService(f);
  try {
    await fire.finish([{type:"text",text:"Report: Bea"},{type:"text",text:"rer syntheticFixtureToken"}]);
    await service.wake();
    const row = await f.db.selectFrom("chat_messages").select(["parts","search_text"]).where("role","=","system").where("chat_id","=","chat_source").executeTakeFirstOrThrow();
    expect(row.parts).toContainEqual({type:"text", text:"Report: Bearer [redacted]"});
    expect(row.search_text).not.toContain("syntheticFixtureToken");
  } finally { await service.close(); }
});
it("delivers the ordered continuation group with credentials redacted across rows", async () => {
  const { terminalFixtureFire, originService } = await import("./routine-chat-origin-support.js");
  const fire = await terminalFixtureFire(f), service = originService(f);
  const owner = { type: "personal" as const, ownerId: OWNER };
  const chatId = fire.routine.chat_id, runId = fire.run.run.id, createdAt = f.state.clock;
  const rootId = "msg_fire_output";
  const continuationId = canonicalAssistantContinuationId(rootId, 1);
  try {
    await f.chats.appendAssistantDelta(owner, { chatId, runId, messageId: rootId, createdAt, delta: "Report: Bea" });
    await f.chats.appendAssistantDelta(owner, { chatId, runId, messageId: "msg_other_output", createdAt, delta: "An unrelated output." });
    await f.chats.appendAssistantDelta(owner, { chatId, runId, messageId: continuationId, createdAt, delta: "rer syntheticFixtureToken\nDelivered in order." });
    await f.chats.finishRun(owner, { chatId, runId, outcome: "completed", completedAt: createdAt });
    await service.reconcile(OWNER, "chat_source");
    await service.reconcile(OWNER, "chat_source");
    const rows = await f.db.selectFrom("chat_messages").select(["parts", "search_text"])
      .where("role", "=", "system").where("chat_id", "=", "chat_source").execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.parts).toEqual([
      expect.objectContaining({ type: "routine_receipt", canonicalMessageId: continuationId, canonicalRunId: runId }),
      { type: "text", text: "Report: Bearer [redacted]\nDelivered in order." },
    ]);
    expect(rows[0]?.search_text).not.toContain("syntheticFixtureToken");
  } finally { await service.close(); }
});
it("bounds recovery reads when the shared production pool has no query or lock timeout", async () => {
  const {sql} = await import("kysely");
  const {machine} = await import("./routine-chat-origin-support.js");
  const {createRoutineChatOriginService} = await import("../../../packages/gateway/src/bots/routine-chat-origin.js");
  let locked!: () => void, release!: () => void;
  const ready = new Promise<void>(done => {locked = done;});
  const hold = new Promise<void>(done => {release = done;});
  const blocker = f.db.transaction().execute(async trx => { await sql`LOCK TABLE routine_chat_deliveries IN ACCESS EXCLUSIVE MODE`.execute(trx); locked(); await hold; });
  await ready;
  try { await f.db.connection().execute(async db => {
    await sql`SET lock_timeout = '0'`.execute(db); await sql`SET statement_timeout = '0'`.execute(db);
    const service = createRoutineChatOriginService({db,transact:f.transact,interactions:f.interactions,chats:f.chats,computerId:scope.computerId,expectedMachine:machine});
    const wake = service.wake().then(() => "unexpected success", () => "bounded failure");
    let guard: ReturnType<typeof setTimeout> | undefined;
    try { expect(await Promise.race([wake,new Promise<string>(resolve => {guard = setTimeout(() => resolve("still blocked"),6500);})])).toBe("bounded failure"); }
    finally { clearTimeout(guard); release(); await blocker; await wake; await service.close(); }
  }); } finally { release(); await blocker; }
});
it("waits at the canonical activation binding and Chat fence without a deadlock", async () => {
  const {admitFixtureRun, originService, decisionProof} = await import("./routine-chat-origin-support.js");
  const {sql} = await import("kysely");
  const {hasLiveRoutineChat} = await import("../../../packages/gateway/src/bots/routine-authorization.js");
  await admitFixtureRun(f); await f.submit(); await f.canonical.drain();
  const interaction = await f.db.selectFrom("bot_interactions").selectAll().executeTakeFirstOrThrow();
  const service = originService(f), input = {kind:"approval" as const,baseRevision:1,decision:"approve" as const};
  let held!: () => void, release!: () => void;
  const ready = new Promise<void>(done=>{held=done;});
  const wait = new Promise<void>(done=>{release=done;});
  const canonical = f.transact(OWNER, async tx => {
    // Match canonical approve: hold the live binding and Chat before writing approval state.
    expect(await hasLiveRoutineChat(tx.db, OWNER, interaction.bot_id, interaction.chat_id, true)).toBe(true);
    held(); await wait;
    return f.interactions.resolveWithin(tx,OWNER,interaction.chat_id,interaction.interaction_id,input);
  });
  await ready;
  const source = service.resolve(OWNER,"chat_source",interaction.interaction_id,input,decisionProof(f,interaction.interaction_id));
  const results = Promise.allSettled([canonical,source]);
  try {
    await expect.poll(async () => Number((await sql<{n:string}>`SELECT count(*) AS n FROM pg_stat_activity
      WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%bot_chat_bindings%'`.execute(f.db)).rows[0].n)).toBeGreaterThan(0);
    release();
    const settled = await results;
    expect(settled.filter(result => result.status==="rejected").map(result => result.reason?.code)).not.toContain("40P01");
    expect(await f.db.selectFrom("bot_routines").select("routine_id").execute()).toHaveLength(1);
  } finally { release(); await results; await service.close(); }
});
