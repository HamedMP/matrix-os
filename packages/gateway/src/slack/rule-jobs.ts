import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { SlackThreadContextEnvelope } from "@matrix-os/contracts/slack-bridge";
import type { OwnerBotDatabase } from "../bots/database.js";
import { findSlackRule, ruleMatches, type SlackRule, type SlackRuleExecutor } from "./rules.js";
export const RULE_SUMMARY_INSTRUCTION = "Summarize the enrolled Slack discussion according to the exact standing rule supplied in this run. Return a private summary and textual suggested to-do list. Do not perform actions.";
export function parseRulePolicy(value: unknown): SlackRule | undefined {
    return value ? (typeof value === "string" ? JSON.parse(value) : value) as SlackRule : undefined;
}
export async function currentRulePolicy(db: SlackRuleExecutor, envelope: SlackThreadContextEnvelope, policy?: SlackRule) {
    const live = await findSlackRule(db, envelope, envelope.grantId);
    if (!policy)
        return Boolean(envelope.summary) && !live;
    return Boolean(live && live.ruleId === policy.ruleId && live.revision === policy.revision && ruleMatches(live, envelope));
}
/** Caller already holds the owner source/Chat lock and summary admission lock. */
export async function receiveRuleJob(tx: Transaction<OwnerBotDatabase>, envelope: SlackThreadContextEnvelope, now: Date, withinCaps: boolean) {
    const rule = await findSlackRule(tx, envelope, envelope.grantId);
    if (!rule)
        return false; // No owner migration yet: legacy rule remains isolated.
    if (!ruleMatches(rule, envelope) || Number(envelope.event.ts)*1000<now.getTime()-86400000 || Number(envelope.event.ts)*1000>now.getTime()+300000)
        return true; // Tombstones and pauses deliberately suppress legacy fallback.
    await sql `DELETE FROM slack_summary_rule_events WHERE owner_id=${envelope.ownerId} AND expires_at<=${now}`.execute(tx);
    const used = await sql<{
        count: string;
    }> `SELECT count(*) FROM slack_summary_rule_events WHERE owner_id=${envelope.ownerId}`.execute(tx);
    if (Number(used.rows[0]!.count) >= 2560)
        return true;
    const inserted = await sql `INSERT INTO slack_summary_rule_events(owner_id,rule_id,revision,message_ts,event_id,expires_at)
 VALUES(${rule.ownerId},${rule.ruleId},${rule.revision},${envelope.event.ts},${envelope.event.eventId},${new Date(now.getTime() + 86400000)}) ON CONFLICT DO NOTHING RETURNING event_id`.execute(tx);
    if (!inserted.rows.length)
        return true;
    const sourceRef={...envelope.source!,eventId:envelope.event.eventId,threadTs:envelope.event.threadTs,ts:envelope.event.ts,userId:envelope.event.userId};
    const coalesce = rule.definition.cadence.kind === "coalesce" ? rule.definition.cadence.seconds * 1000 : 0;
    if (coalesce) {
        const existing = await sql<{
            id: string;
            envelope: unknown;
            sources: unknown[];
        }> `SELECT id,envelope,sources FROM slack_mention_summary_jobs
   WHERE owner_id=${rule.ownerId} AND policy->>'ruleId'=${rule.ruleId} AND (policy->>'revision')::bigint=${rule.revision}
   AND envelope->'event'->>'threadTs'=${envelope.event.threadTs} AND state='pending' AND next_at>${now} ORDER BY created_at LIMIT 1 FOR UPDATE`.execute(tx);
        const row = existing.rows[0];
        if (row) {
            if (row.sources.length < 32)
                await sql `UPDATE slack_mention_summary_jobs SET sources=sources || ${JSON.stringify([sourceRef])}::jsonb WHERE id=${row.id}`.execute(tx);
            return true;
        }
    }
    if (!withinCaps)
        return true;
    const digest = createHash("sha256").update(JSON.stringify([rule.ownerId, rule.grantId, rule.ruleId, rule.revision, envelope.event.channelId, envelope.event.ts])).digest("hex");
    const id = "req_slack_summary_" + digest.slice(0, 40);
    await sql `INSERT INTO slack_mention_summary_jobs(id,event_key,owner_id,bot_id,chat_id,envelope,request_id,state,attempts,next_at,created_at,expires_at,policy,sources)
 VALUES(${id},${digest},${rule.ownerId},${rule.botId},${rule.chatId},${JSON.stringify(envelope)}::jsonb,${id},'pending',0,${new Date(now.getTime() + coalesce)},${now},${new Date(now.getTime() + 86400000)},${JSON.stringify(rule)}::jsonb,${JSON.stringify([sourceRef])}::jsonb) ON CONFLICT DO NOTHING`.execute(tx);
    return true;
}
