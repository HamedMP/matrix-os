import { RULE_SUMMARY_INSTRUCTION } from "../../packages/gateway/src/slack/rule-jobs.js";
import { SUMMARY_INSTRUCTION } from "../../packages/gateway/src/slack/mention-summary.js";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { afterEach, expect, it } from "vitest";
import { createRealBotStateDatabase, insertChat } from "./bots/bot-state-support.js";
import { createSlackMentionSummaries } from "../../packages/gateway/src/slack/mention-summary.js";
import { createPrivateSlackThreadContext } from "../../packages/gateway/src/slack/private-thread-context.js";
import { createSlackRulesRepository } from "../../packages/gateway/src/slack/rules.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of clean.splice(0).reverse())
    await close(); });
async function setup(legacy = false, queued = false, authorize:()=>Promise<boolean>=async()=>true,onRead?:()=>Promise<void>) {
    const f = await createRealBotStateDatabase();
    clean.push(f.destroy);
    const ownerId = "user_rules", botId = "bot_0123456789abcdef", chatId = "chat_rules", runtimeId = "preview_runtime", grantId = "a".repeat(64);
    const target = { ownerId, botId, chatId, runtimeId }, owner = { type: "personal" as const, ownerId };
    await insertChat(f.db, chatId, ownerId);
    await f.db.insertInto("bot_chat_bindings").values({ owner_id: ownerId, bot_id: botId, chat_id: chatId, kind: "direct", created_at: new Date(), removed_at: null }).execute();
    const rules = createSlackRulesRepository(f.db), input = { ...target, grantId, sourceId: "slack_enrolled_" + "b".repeat(32), channelId: "C123", label: "#tech", originMessageId: "msg_owner", now: new Date(Date.now() - 10000).toISOString(), definition: { trigger: "new_message" as const, cadence: { kind: "immediate" as const }, focus: "risks", language: "English" } };
    let rule = legacy ? undefined : await rules.save(input);
    const summaries = await createSlackMentionSummaries({ db: f.db, ownerId, runtimeId, authorize, readThread: async () => {await onRead?.();return {recipientUserId:"U123",messages:[],partial:false};} });
    clean.push(summaries.close);
    const context = await createPrivateSlackThreadContext({ db: f.db, ownerId, runtimeId, authorize: async () => true, onReceive: summaries.receive });
    const ts = `${Math.floor(Date.now() / 1000)}.000001`, text = "Ordinary release update";
    await context.receive({ ...target, grantId, event: { appId: "A123", teamId: "T123", channelId: "C123", threadTs: ts, ts, eventId: "EvRules", userId: "U456", text }, ...(legacy ? { summary: { ruleId: "legacy", version: 1, proof: "b".repeat(64) } } : { source: { version: 1 as const, ownerMention: false, textDigest: createHash("sha256").update(text).digest("hex"), proof: "b".repeat(64) } }) });
    await sql `UPDATE slack_mention_summary_jobs SET state='processing'`.execute(f.db);
    const requestId = (await sql<{
        request_id: string;
    }> `SELECT request_id FROM slack_mention_summary_jobs`.execute(f.db)).rows[0]!.request_id;
    const repository = new ChatRepository(f.db), at = new Date().toISOString(), selection = { instanceId: "matrix_bot_default", model: "auto" };
    await repository.admitTurn(owner, { chatId, baseRevision: 0, message: { id: "msg_input", chatId, turnId: "cturn_rules", seq: 1, role: "user", state: "committed", actorId: ownerId, parts: [{ type: "text", text: legacy?SUMMARY_INSTRUCTION:RULE_SUMMARY_INSTRUCTION }], createdAt: at }, turn: { id: "cturn_rules", chatId, clientRequestId: queued ? "req_manual" : requestId, baseMessageSeq: 0, inputMessageId: "msg_input", status: "accepted", createdAt: at, updatedAt: at }, run: { id: "run_rules", chatId, turnId: "cturn_rules", attempt: 1, driverKind: "matrix_bot", instanceId: selection.instanceId, selection, interactionMode: "default", permissionMode: "default", status: "accepted", historyBoundarySeq: 0, capabilitySnapshot: { revision: "fixture", rootChat: true, attachments: [], resources: [], tools: [], approvals: false, userInput: false, resume: false, cancellation: true, steering: "none", worktrees: "none", interactionModes: ["default"], permissionModes: ["default"] }, createdAt: at, updatedAt: at } });
    return { ...f, target, owner, chatId, at, rules, repository, requestId, selection, summaries,rule, async enqueue() { return repository.enqueueQueuedTurn(owner, { chatId, queuedTurnId: "qturn_rules", clientRequestId: requestId, baseRevision: (await repository.get(owner, chatId))!.chat.revision, parts: [{ type: "text", text: legacy?SUMMARY_INSTRUCTION:RULE_SUMMARY_INSTRUCTION }], driverKind: "matrix_bot", selection, interactionMode: "default", permissionMode: "default", createdAt: at, capabilitySnapshot: { revision: "fixture", rootChat: true, attachments: [], resources: [], tools: [], approvals: false, userInput: false, resume: false, cancellation: true, steering: "none", worktrees: "none", interactionModes: ["default"], permissionModes: ["default"] } }); }, async pause() { if (!rule)
            rule = await rules.save(input); return rules.change(target, { ruleId: rule.ruleId, baseRevision: rule.revision, operation: "pause", originMessageId: "msg_pause", now: new Date().toISOString() }); }, append() { return repository.appendAssistantDelta(owner, { chatId, runId: "run_rules", messageId: "msg_summary", delta: "Private summary", createdAt: at }); } };
}
it.each([false, true])("fences late output for owner/legacy policy after pause (legacy=%s)", async (legacy) => { const f = await setup(legacy); await f.pause(); await expect(f.append()).rejects.toBeDefined(); expect(await f.db.selectFrom("chat_messages").select("id").where("role", "=", "assistant").execute()).toHaveLength(0); });
it("fails closed when the durable job disappears after successful preflight", async () => { const f = await setup(); await sql `DELETE FROM slack_mention_summary_jobs`.execute(f.db); await expect(f.append()).rejects.toBeDefined(); });
it("does not finalize existing streaming text as committed after a rule pause", async () => { const f = await setup(); await f.append(); await f.pause(); await expect(f.repository.finishRun(f.owner, { chatId: f.chatId, runId: "run_rules", outcome: "completed", completedAt: f.at })).rejects.toBeDefined(); });
it("cancels a revoked summary queue at claim instead of promoting a failed Run", async () => { const f = await setup(false, true); await f.enqueue(); await f.repository.finishRun(f.owner, { chatId: f.chatId, runId: "run_rules", outcome: "failed", completedAt: f.at }); await f.pause(); expect(await f.repository.claimNextQueuedTurn(f.owner, { chatId: f.chatId, turnId: "cturn_unwanted", runId: "run_unwanted", messageId: "msg_unwanted", claimedAt: f.at })).toBeNull(); expect(await f.db.selectFrom("chat_runs").select("id").execute()).toHaveLength(1); expect(await f.db.selectFrom("chat_queued_turns").select("status").execute()).toEqual([{ status: "cancelled" }]); });

it("serializes the final one-inference CAS with a concurrently paused rule",async()=>{
 let authorizations=0;
 const f=await setup(false,false,async()=>{authorizations++;return true;});
 let release!:()=>void,locked!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});
 const ready=new Promise<void>(resolve=>{locked=resolve;});
 const pause=f.db.transaction().execute(async tx=>{
  await f.rules.change(f.target,{ruleId:f.rule!.ruleId,baseRevision:1,operation:"pause",originMessageId:"msg_pause",now:new Date().toISOString()},tx);
  locked();await held;
 });
 await ready;
 const inference=f.summaries.consumeInference({...f.target,runId:"run_rules"});
 try{
  await expect.poll(()=>authorizations).toBeGreaterThan(0);
  const first=await Promise.race([inference.then(value=>({settled:true,value})),new Promise<{settled:false}>(resolve=>setTimeout(()=>resolve({settled:false}),100))]);
  expect(first).toEqual({settled:false});
 }finally{release();await pause;}
 expect(await inference).toBe(false);
 expect((await sql<{inference_at:unknown}>`SELECT inference_at FROM slack_mention_summary_jobs`.execute(f.db)).rows[0]!.inference_at).toBeNull();
});

it("denies source context and inference when membership is revoked during the source read",async()=>{let allowed=true,reads=0;const f=await setup(false,false,async()=>allowed,async()=>{reads++;allowed=false;});await expect(f.summaries.prompt({...f.target,runId:"run_rules"},AbortSignal.timeout(5000))).rejects.toBeDefined();expect(reads).toBe(1);expect(await f.summaries.consumeInference({...f.target,runId:"run_rules"})).toBe(false);});
