import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { SLACK_RULE_PILOT_LIMITS, CanonicalChatMessageSchema } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "../bots/database.js";
import { jsonb } from "../chat/records.js";
import type { SlackRule } from "./rules.js";
/** The receipt and policy revision share one transaction. No Run or Slack effect. */
export async function appendSlackRuleReceipt(tx: Transaction<OwnerBotDatabase>, rule: SlackRule, operation: string, at: string) {
    const text = `Slack summary rule ${operation} committed.\n${JSON.stringify({ ruleId: rule.ruleId, revision: rule.revision, state: rule.status, source: rule.label, channelId: rule.channelId, trigger: rule.definition.trigger, cadence: rule.definition.cadence, focus: rule.definition.focus, language: rule.definition.language, destination: "This private Matrix Chat", enabledAfter: rule.enabledAfter,limits:SLACK_RULE_PILOT_LIMITS })}`;
    const latest = await tx.selectFrom("chat_messages").select(eb => eb.fn.max<number>("seq").as("seq")).where("chat_id", "=", rule.chatId).executeTakeFirst();
    const message = CanonicalChatMessageSchema.parse({ id: `msg_${randomUUID().replaceAll("-", "")}`, chatId: rule.chatId, seq: Number(latest?.seq ?? 0) + 1, role: "system", state: "committed", purpose: "system", parts: [{ type: "text", text }], createdAt: at });
    await tx.insertInto("chat_messages").values({ id: message.id, chat_id: rule.chatId, seq: message.seq, role: "system", purpose: "system", state: "committed", actor_id: null, run_id: null, turn_id: null, parts: jsonb(message.parts), byte_count: Buffer.byteLength(text), search_text: text, created_at: at }).execute();
    const changed = await tx.updateTable("chats").set({ revision: sql<number> `revision+1`, message_count: sql<number> `message_count+1`, last_message_preview: text.slice(0, 280), activity_at: at, updated_at: at }).where("id", "=", rule.chatId).returning("revision").executeTakeFirstOrThrow();
    await tx.insertInto("chat_outbox").values({ owner_type: "personal", owner_id: rule.ownerId, chat_id: rule.chatId, revision: Number(changed.revision), event_type: "chat.updated", payload: jsonb({ messageId: message.id, seq: message.seq }), created_at: at }).execute();
    await tx.insertInto("chat_outbox").values({ owner_type: "personal", owner_id: rule.ownerId, chat_id: rule.chatId, revision: Number(changed.revision), event_type: "bot.authority.changed", payload: jsonb({ agentId: rule.botId, revision: rule.revision }), created_at: at }).execute();
    return { ruleId: rule.ruleId, revision: rule.revision, state: rule.status, source: rule.label, trigger: rule.definition.trigger, cadence: rule.definition.cadence, focus: rule.definition.focus, language: rule.definition.language, destination: "This private Matrix Chat", receiptMessageId: message.id,enabledAfter:rule.enabledAfter,limits:SLACK_RULE_PILOT_LIMITS };
}
