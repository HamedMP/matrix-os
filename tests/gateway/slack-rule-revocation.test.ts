import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { SlackThreadContextEnvelope } from "@matrix-os/contracts/slack-bridge";
import { ownerRuleHarness } from "./slack-rule-tools-support.js";
import { createSlackMentionSummaries } from "../../packages/gateway/src/slack/mention-summary.js";
import { RULE_SUMMARY_INSTRUCTION } from "../../packages/gateway/src/slack/rule-jobs.js";
import { createSlackRulesRepository, type SlackRule } from "../../packages/gateway/src/slack/rules.js";
import { createSlackRuleTools } from "../../packages/gateway/src/slack/rule-tools.js";
import { retireRevokedSlackJobs } from "../../packages/gateway/src/slack/rule-revocation.js";
const instruction = "From now on summarize every new message in #tech immediately in English, focus on release risks.";
const definition = { trigger: "new_message" as const, cadence: { kind: "immediate" as const }, focus: "release risks", language: "English" };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const clock = new Date(Date.now() - 10000);
  const h = await ownerRuleHarness({ now: () => clock });
  cleanup.push(h.destroy);
  const origin = await h.turn(instruction);
  await h.call(origin, { operation: "create", sourceId: h.sourceId, definition, ownerInstruction: instruction });
  const rules = createSlackRulesRepository(h.db);
  const target = { ownerId: origin.ownerId, botId: origin.botId, chatId: origin.chatId, runtimeId: "preview_runtime" };
  const rule = (await rules.list(target))[0]!;
  await h.finish();
  const manual = await h.turn("Keep my current manual task separate.");
  const summaries = await createSlackMentionSummaries({ db: h.db, ...target, authorize: async () => true, readThread: async () => null });
  cleanup.push(summaries.close);
  const seed = async (policy: SlackRule, digit: string, state: "pending" | "processing" = "pending") => {
    const requestId = `req_slack_summary_${digit.repeat(40)}`;
    const text = "Ordinary human source";
    const envelope: SlackThreadContextEnvelope = { ...target, grantId: rule.grantId,
      source: { version: 1, ownerMention: false, textDigest: createHash("sha256").update(text).digest("hex"), proof: "b".repeat(64) },
      event: { appId: "A123", teamId: "T123", channelId: "C123", threadTs: "1795000000.000001",
        ts: `${Math.floor(Date.now() / 1000)}.000001`, eventId: `EvRetire${digit}`, userId: "U456", text } };
    await sql`INSERT INTO slack_mention_summary_jobs(id,event_key,owner_id,bot_id,chat_id,envelope,request_id,state,attempts,next_at,created_at,expires_at,policy,sources)
      VALUES(${requestId},${digit.repeat(64)},${target.ownerId},${target.botId},${target.chatId},${JSON.stringify(envelope)}::jsonb,
      ${requestId},${state},1,now(),now(),now()+interval '1 hour',${JSON.stringify(policy)}::jsonb,'[]'::jsonb)`.execute(h.db);
    return requestId;
  };
  const requestId = await seed(rule, "a", "processing");
  const snapshot = { revision: "fixture", rootChat: true, attachments: [], resources: [], tools: [], approvals: false,
    userInput: false, resume: false, cancellation: true, steering: "none" as const, worktrees: "none" as const,
    interactionModes: ["default"], permissionModes: ["default"] };
  await h.repository.enqueueQueuedTurn(h.owner, { chatId: target.chatId, queuedTurnId: "qturn_retire", clientRequestId: requestId,
    baseRevision: (await h.repository.get(h.owner, target.chatId))!.chat.revision, parts: [{ type: "text", text: RULE_SUMMARY_INSTRUCTION }],
    driverKind: "matrix_bot", selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default",
    permissionMode: "default", createdAt: new Date().toISOString(), capabilitySnapshot: snapshot });
  await sql`UPDATE slack_mention_summary_jobs SET state='accepted',accepted_kind='queue',accepted_id='qturn_retire' WHERE id=${requestId}`.execute(h.db);
  return { ...h, target, rule, rules, manual, requestId, seed };
}
it("retires stale queued work after an update while preserving the manual Run and a current job", async () => {
  const f = await setup();
  const current = await f.rules.change(f.target, { ruleId: f.rule.ruleId, baseRevision: 1, operation: "update", definition,
    originMessageId: "msg_update", now: new Date(Date.now() - 1000).toISOString() });
  const validId = await f.seed(current, "c");
  const stop = vi.fn(async () => {});
  await retireRevokedSlackJobs(f.db, f.target.ownerId, f.target.chatId, stop);
  expect((await sql`SELECT state FROM slack_mention_summary_jobs WHERE id=${f.requestId}`.execute(f.db)).rows).toEqual([{ state: "failed" }]);
  expect((await sql`SELECT state FROM slack_mention_summary_jobs WHERE id=${validId}`.execute(f.db)).rows).toEqual([{ state: "pending" }]);
  expect(await f.db.selectFrom("chat_queued_turns").select("status").where("id", "=", "qturn_retire").execute()).toEqual([{ status: "cancelled" }]);
  expect(await f.db.selectFrom("chat_outbox").select("event_type").where("event_type", "=", "queue.cancelled").execute()).toHaveLength(1);
  expect((await f.db.selectFrom("chat_runs").select("status").where("id", "=", f.manual.runId).executeTakeFirstOrThrow()).status).toBe("accepted");
  expect(stop).not.toHaveBeenCalled();
});
it("stops only the exact promoted summary Run after a committed pause", async () => {
  const f = await setup();
  await f.finish();
  const claim = await f.repository.claimNextQueuedTurn(f.owner, { chatId: f.target.chatId, turnId: "cturn_retire",
    runId: "run_retire", messageId: "msg_retire", claimedAt: new Date().toISOString() });
  expect(claim?.run.id).toBe("run_retire");
  await f.rules.change(f.target, { ruleId: f.rule.ruleId, baseRevision: 1, operation: "pause", originMessageId: "msg_pause", now: new Date().toISOString() });
  const stop = vi.fn(async (runId: string) => {
    expect((await f.rules.list(f.target))[0]!.status).toBe("paused"); // Separate connection sees committed authority.
    await f.repository.finishRun(f.owner, { chatId: f.target.chatId, runId, outcome: "aborted", completedAt: new Date().toISOString() });
  });
  await retireRevokedSlackJobs(f.db, f.target.ownerId, f.target.chatId, stop);
  expect(stop).toHaveBeenCalledExactlyOnceWith("run_retire");
  expect((await f.db.selectFrom("chat_runs").select("status").where("id", "=", "run_retire").executeTakeFirstOrThrow()).status).toBe("aborted");
});
it("retains the committed receipt when post-commit retirement fails", async () => {
  const f = await ownerRuleHarness(); cleanup.push(f.destroy);
  const initial = await f.turn(instruction);
  const created = await f.call(initial, { operation: "create", sourceId: f.sourceId, definition, ownerInstruction: instruction });
  const text = "Please pause my Slack summary rule.", binding = await f.turn(text);
  const afterCommit = vi.fn(async () => { throw new Error("Synthetic worker stop failure"); });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const tools = createSlackRuleTools({ db: f.db, ownerId: binding.ownerId, runtimeId: "preview_runtime",
    context: { enrollment: async () => undefined }, afterCommit });
  const reply = await tools.execute(binding, { operation: "pause", ruleId: created.receipt.ruleId, baseRevision: 1, ownerInstruction: text }, AbortSignal.timeout(5000));
  const answer = JSON.parse(reply.content.map(part => part.type === "text" ? part.text : "").join(""));
  expect(answer).toMatchObject({ saved: true, receipt: { state: "paused", revision: 2 } });
  expect(await f.db.selectFrom("chat_messages").select("id").where("id", "=", answer.receipt.receiptMessageId).execute()).toHaveLength(1);
  expect(afterCommit).toHaveBeenCalledOnce(); expect(warn).toHaveBeenCalledOnce();
});
