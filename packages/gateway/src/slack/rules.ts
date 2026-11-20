import { randomUUID } from "node:crypto";
import { SlackRuleDefinitionSchema, type SlackRuleDefinition } from "@matrix-os/contracts";
import { sql, type Kysely, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "../bots/database.js";
import { hasNonPrivateChatScope } from "../chat/private-routine-authority.js";
import { BotStateError } from "../bots/repositories/shared.js";
export interface SlackRule {
    ruleId: string;
    ownerId: string;
    botId: string;
    chatId: string;
    runtimeId: string;
    grantId: string;
    sourceId: string;
    channelId: string;
    label: string;
    revision: number;
    status: "active" | "paused" | "deleted";
    definition: SlackRuleDefinition;
    enabledAfter: string;
    originMessageId: string;
}
export type SlackRuleTarget = Pick<SlackRule, "ownerId" | "botId" | "chatId" | "runtimeId">;
export type SlackRuleExecutor = Kysely<OwnerBotDatabase> | Transaction<OwnerBotDatabase>;
interface Row {
    document: SlackRule | string;
}
const parse = (row: Row): SlackRule => typeof row.document === "string" ? JSON.parse(row.document) : row.document;
/** Lock Chat first: all lifecycle changes and private output share this serialization boundary. */
export async function lockSlackRuleChat(tx: SlackRuleExecutor, target: SlackRuleTarget) {
    const chat = await tx.selectFrom("chats").select("id").where("id", "=", target.chatId).where("owner_type", "=", "personal")
        .where("owner_id", "=", target.ownerId).where("lifecycle", "=", "active").where("collaboration", "is", null).where("project_id", "is", null).forNoKeyUpdate().executeTakeFirst();
    const binding = await tx.selectFrom("bot_chat_bindings").select("bot_id").where("owner_id", "=", target.ownerId).where("bot_id", "=", target.botId)
        .where("chat_id", "=", target.chatId).where("kind", "=", "direct").where("removed_at", "is", null).forShare().executeTakeFirst();
    if (!chat || !binding || await hasNonPrivateChatScope(tx, { type: "personal", ownerId: target.ownerId }, target.chatId))
        throw new BotStateError("invalid_input");
}
export async function findSlackRule(tx: SlackRuleExecutor, target: SlackRuleTarget, grantId: string): Promise<SlackRule | undefined> {
    const rows = await sql<Row> `SELECT document FROM slack_summary_rules WHERE owner_id=${target.ownerId} AND bot_id=${target.botId} AND grant_id=${grantId}`.execute(tx);
    return rows.rows[0] ? parse(rows.rows[0]) : undefined;
}
export function ruleMatches(rule: SlackRule, input: {
    runtimeId: string;
    chatId: string;
    event: {
        ts: string;
        channelId: string;
    };
    source?: {
        ownerMention: boolean;
    };
}) {
    return rule.status === "active" && rule.runtimeId === input.runtimeId && rule.chatId === input.chatId && rule.channelId === input.event.channelId && Boolean(input.source)
        && Number(input.event.ts) * 1000 > Date.parse(rule.enabledAfter)
        && (rule.definition.trigger === "new_message" || input.source!.ownerMention);
}
export function createSlackRulesRepository(db: Kysely<OwnerBotDatabase>) {
    async function record(tx: SlackRuleExecutor, rule: SlackRule) {
        await sql `INSERT INTO slack_summary_rule_revisions(rule_id,revision,document) VALUES(${rule.ruleId},${rule.revision},${JSON.stringify(rule)}::jsonb)`.execute(tx);
    }
    return {
        async save(input: Omit<SlackRule, "ruleId" | "revision" | "status" | "enabledAfter"> & {
            now: string;
        }, within?: Transaction<OwnerBotDatabase>): Promise<SlackRule> {
            const work = async (tx: Transaction<OwnerBotDatabase>) => {
                await lockSlackRuleChat(tx, input);
                const definition = SlackRuleDefinitionSchema.parse(input.definition);
                const tombstone = await findSlackRule(tx, input, input.grantId);
                if (tombstone?.status === "deleted" && tombstone.originMessageId !== input.originMessageId) {
                    const restored: SlackRule = { ...tombstone, ...input, definition, ruleId: tombstone.ruleId, revision: tombstone.revision + 1, status: "active", enabledAfter: input.now };
                    const changed=await sql `UPDATE slack_summary_rules SET revision=${restored.revision},status='active',document=${JSON.stringify(restored)}::jsonb WHERE rule_id=${restored.ruleId} AND revision=${tombstone.revision} AND status='deleted' RETURNING rule_id`.execute(tx);
                    if(!changed.rows.length)throw new BotStateError("revision_conflict");
                    await record(tx, restored);
                    return restored;
                }
                const count = await sql<{
                    count: string;
                }> `SELECT count(*) FROM slack_summary_rules WHERE owner_id=${input.ownerId} AND bot_id=${input.botId}`.execute(tx);
                if (!tombstone && Number(count.rows[0]!.count) >= 16)
                    throw new BotStateError("capacity_exceeded");
                const rule: SlackRule = { ...input, definition, ruleId: `srule_${randomUUID().replaceAll("-", "")}`, revision: 1, status: "active", enabledAfter: input.now };
                const inserted = await sql `INSERT INTO slack_summary_rules(rule_id,owner_id,bot_id,chat_id,runtime_id,grant_id,revision,status,document)
          VALUES(${rule.ruleId},${rule.ownerId},${rule.botId},${rule.chatId},${rule.runtimeId},${rule.grantId},1,'active',${JSON.stringify(rule)}::jsonb)
          ON CONFLICT(owner_id,bot_id,grant_id) DO NOTHING RETURNING rule_id`.execute(tx);
                if (!inserted.rows.length) {
                    const prior = await findSlackRule(tx, input, input.grantId);
                    if (prior?.originMessageId === input.originMessageId && prior.definition.trigger === definition.trigger && prior.definition.focus === definition.focus && prior.definition.language === definition.language && prior.definition.cadence.kind === definition.cadence.kind && (prior.definition.cadence.kind !== "coalesce" || definition.cadence.kind === "coalesce" && prior.definition.cadence.seconds === definition.cadence.seconds))
                        return prior;
                    throw new BotStateError("conflict");
                }
                await record(tx, rule);
                return rule;
            };
            return within ? work(within) : db.transaction().execute(work);
        },
        async list(target: SlackRuleTarget, executor: SlackRuleExecutor = db): Promise<SlackRule[]> {
            return (await sql<Row> `SELECT document FROM slack_summary_rules WHERE owner_id=${target.ownerId} AND bot_id=${target.botId} AND chat_id=${target.chatId} AND runtime_id=${target.runtimeId} ORDER BY rule_id LIMIT 16`.execute(executor)).rows.map(parse);
        },
        async change(target: SlackRuleTarget, input: {
            ruleId: string;
            baseRevision: number;
            operation: "update" | "pause" | "resume" | "delete";
            definition?: SlackRuleDefinition;
            originMessageId: string;
            now: string;
        }, within?: Transaction<OwnerBotDatabase>) {
            const work = async (tx: Transaction<OwnerBotDatabase>) => {
                await lockSlackRuleChat(tx, target);
                const rows = await sql<Row> `SELECT document FROM slack_summary_rules WHERE rule_id=${input.ruleId} AND owner_id=${target.ownerId} AND bot_id=${target.botId} AND chat_id=${target.chatId} AND runtime_id=${target.runtimeId} FOR UPDATE`.execute(tx);
                const prior = rows.rows[0] && parse(rows.rows[0]);
                if (!prior)
                    throw new BotStateError("not_found");
                if (prior.revision !== input.baseRevision)
                    throw new BotStateError("revision_conflict");
                if (prior.status === "deleted" || input.operation === "resume" && prior.status !== "paused")
                    throw new BotStateError("invalid_transition");
                const rule: SlackRule = { ...prior, revision: prior.revision + 1, originMessageId: input.originMessageId,
                    status: input.operation === "pause" ? "paused" : input.operation === "delete" ? "deleted" : input.operation === "resume" ? "active" : prior.status,
                    definition: input.definition ? SlackRuleDefinitionSchema.parse(input.definition) : prior.definition, enabledAfter: input.now };
                const changed = await sql `UPDATE slack_summary_rules SET revision=${rule.revision},status=${rule.status},document=${JSON.stringify(rule)}::jsonb WHERE rule_id=${rule.ruleId} AND revision=${input.baseRevision} RETURNING rule_id`.execute(tx);
                if (!changed.rows.length)
                    throw new BotStateError("revision_conflict");
                await record(tx, rule);
                return rule;
            };
            return within ? work(within) : db.transaction().execute(work);
        },
    };
}
