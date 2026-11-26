import { afterEach,expect,it } from "vitest";
import { ownerRuleHarness } from "./slack-rule-tools-support.js";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of clean.splice(0).reverse())
    await close(); });
const definition = { trigger: "new_message" as const, cadence: { kind: "immediate" as const }, focus: "release risks", language: "English" };
const instruction = "From now on summarize every new message in #tech immediately in English, focus on release risks.";
async function setup() { const f = await ownerRuleHarness(); clean.push(f.destroy); return f; }
it("commits an exact HTTP owner standing instruction and receipt; old create cannot undo later pause", async () => {
    const f = await setup(), binding = await f.turn(instruction);
    const args = { operation: "create" as const, sourceId: f.sourceId, definition, ownerInstruction: instruction };
    const created = await f.call(binding, args);
    expect(created).toMatchObject({ saved: true, receipt: { state: "active", revision: 1, cadence: { kind: "immediate" }, language: "English" } });
    expect(await f.db.selectFrom("chat_messages").select("id").where("role", "=", "system").execute()).toHaveLength(1);
    const pause = "Please pause my Slack summary rule.";
    const second = await f.turn(pause);
    const paused = await f.call(second, { operation: "pause", ruleId: created.receipt.ruleId, baseRevision: 1, ownerInstruction: pause });
    expect(paused.receipt.state).toBe("paused");
    const replay = await f.call(binding, args);
    expect(replay).toMatchObject({ saved: false, superseded: true, current: { status: "paused", revision: 2 } });
});
it("rejects internally admitted Slack input even with an exact copy of a standing owner instruction", async () => {
    const f = await setup(), binding = await f.turn(instruction, false);
    await expect(f.tools.execute(binding, { operation: "create", sourceId: f.sourceId, definition, ownerInstruction: instruction }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "denied" });
});
it("allows local pause when the enrolled Slack read authority has been revoked", async () => {
    const f = await setup(), binding = await f.turn(instruction);
    const created = await f.call(binding, { operation: "create", sourceId: f.sourceId, definition, ownerInstruction: instruction });
    const pause = "Please pause my Slack summary rule.";
    const second = await f.turn(pause);
    f.revoke();
    expect(await f.call(second, { operation: "pause", ruleId: created.receipt.ruleId, baseRevision: 1, ownerInstruction: pause })).toMatchObject({ saved: true, receipt: { state: "paused" } });
});
it("deletes and explicitly recreates a new revision without replaying an old create", async () => {
    const f = await setup();
    const first = await f.turn(instruction);
    const args = { operation: "create" as const, sourceId: f.sourceId, definition, ownerInstruction: instruction };
    const created = await f.call(first, args);
    const remove = "Please delete my Slack summary rule.";
    const deletion = await f.turn(remove);
    expect(await f.call(deletion, { operation: "delete", ruleId: created.receipt.ruleId, baseRevision: 1, ownerInstruction: remove })).toMatchObject({ saved: true, receipt: { state: "deleted" } });
    expect(await f.call(first, args)).toMatchObject({ saved: false, superseded: true, current: { status: "deleted" } });
    const fresh = await f.turn(instruction);
    expect(await f.call(fresh, args)).toMatchObject({ saved: true, receipt: { ruleId: created.receipt.ruleId, revision: 3, state: "active" } });
    expect(await f.call(first, args)).toMatchObject({ saved: false, superseded: true, current: { status: "active", revision: 3 } });
});
it("asks for a fresh owner instruction when this run already consumed an imported tool result", async () => {
    const { createBotTasksRepository } = await import("../../packages/gateway/src/bots/repositories/tasks.js");
    const { createBotCheckpointsRepository } = await import("../../packages/gateway/src/bots/repositories/checkpoints.js");
    const f = await setup(), binding = await f.turn(instruction);
    const task = await createBotTasksRepository(f.db).create({ ownerId: binding.ownerId, botId: binding.botId, chatId: binding.chatId, now: new Date().toISOString() });
    await createBotCheckpointsRepository(f.db).prepare({ ownerId: binding.ownerId, taskId: task.taskId, runId: binding.runId, toolCallId: "call_imported", action: { capability: "integration.call", argsHash: "a".repeat(64) }, effectClass: "read", now: new Date().toISOString() });
    expect(await f.call(binding, { operation: "create", sourceId: f.sourceId, definition, ownerInstruction: instruction })).toMatchObject({ saved: false });
    expect(await f.db.selectFrom("chat_messages").select("id").where("role", "=", "system").execute()).toHaveLength(0);
});
it("updates by CAS, resumes only future messages and keeps the exact new report focus",async()=>{
 let clock=new Date();const f=await ownerRuleHarness({now:()=>clock});clean.push(f.destroy);
 const first=await f.turn(instruction);const created=await f.call(first,{operation:"create",sourceId:f.sourceId,definition,ownerInstruction:instruction});
 clock=new Date(clock.getTime()+1000);
 const update="Update my Slack summary rule in #tech: summarize every new message immediately in English, focus on deployment blockers.";
 const updatedDefinition={...definition,focus:"deployment blockers"};
 const second=await f.turn(update);expect(await f.call(second,{operation:"update",ruleId:created.receipt.ruleId,baseRevision:1,definition:updatedDefinition,ownerInstruction:update})).toMatchObject({saved:true,receipt:{revision:2,focus:"deployment blockers"}});
 const stale=await f.turn(update);expect(await f.call(stale,{operation:"update",ruleId:created.receipt.ruleId,baseRevision:1,definition:updatedDefinition,ownerInstruction:update})).toMatchObject({saved:false,reason:"revision_conflict"});
 const pause="Please pause my Slack summary rule.";const paused=await f.turn(pause);expect(await f.call(paused,{operation:"pause",ruleId:created.receipt.ruleId,baseRevision:2,ownerInstruction:pause})).toMatchObject({saved:true,receipt:{revision:3,state:"paused"}});
 clock=new Date(clock.getTime()+1000);
 const resume="Please resume my Slack summary rule.";const resumed=await f.turn(resume);expect(await f.call(resumed,{operation:"resume",ruleId:created.receipt.ruleId,baseRevision:3,ownerInstruction:resume})).toMatchObject({saved:true,receipt:{revision:4,state:"active",focus:"deployment blockers"}});
 const {createSlackMentionSummaries}=await import("../../packages/gateway/src/slack/mention-summary.js");const {createPrivateSlackThreadContext}=await import("../../packages/gateway/src/slack/private-thread-context.js");const {createHash}=await import("node:crypto");
 const service=await createSlackMentionSummaries({db:f.db,ownerId:first.ownerId,runtimeId:"preview_runtime",now:()=>clock,authorize:async()=>true,readThread:async()=>({recipientUserId:"U123",messages:[],partial:false})});clean.push(service.close);
 const context=await createPrivateSlackThreadContext({db:f.db,ownerId:first.ownerId,runtimeId:"preview_runtime",authorize:async()=>true,onReceive:service.receive});const text="Ordinary release update";
 const envelope={ownerId:first.ownerId,botId:first.botId,chatId:first.chatId,runtimeId:"preview_runtime",grantId:"a".repeat(64),event:{appId:"A123",teamId:"T123",channelId:"C123",threadTs:"1795161600.000001",ts:`${Math.floor(clock.getTime()/1000)-10}.000001`,eventId:"EvOld",userId:"U456",text},source:{version:1 as const,ownerMention:false,textDigest:createHash("sha256").update(text).digest("hex"),proof:"b".repeat(64)}};
 const submitted:unknown[]=[];service.attach(async record=>{submitted.push(record);return {runId:"run_future"};});await context.receive(envelope);await service.drain();expect(submitted).toHaveLength(0);
 await context.receive({...envelope,event:{...envelope.event,eventId:"EvFuture",ts:`${Math.floor(clock.getTime()/1000)+1}.000001`}});await service.drain();expect(submitted).toHaveLength(1);
});
