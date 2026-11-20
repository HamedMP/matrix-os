import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "./database.js";
/** Rules are owner data. A deleted singleton remains a fence against legacy automation. */
export async function migrateSlackRulesV19(tx: Transaction<OwnerBotDatabase>) {
    await sql `CREATE TABLE slack_summary_rules (
    rule_id TEXT PRIMARY KEY CHECK(rule_id ~ '^srule_[a-f0-9]{32}$'),
    owner_id TEXT NOT NULL, bot_id TEXT NOT NULL, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    runtime_id TEXT NOT NULL, grant_id TEXT NOT NULL CHECK(grant_id ~ '^[a-f0-9]{64}$'),
    revision BIGINT NOT NULL CHECK(revision>0), status TEXT NOT NULL CHECK(status IN('active','paused','deleted')),
    document JSONB NOT NULL CHECK(jsonb_typeof(document)='object' AND octet_length(document::text)<=24000),
    UNIQUE(owner_id,bot_id,grant_id)
  )`.execute(tx);
    await sql `CREATE TABLE slack_summary_rule_revisions (
    rule_id TEXT NOT NULL REFERENCES slack_summary_rules(rule_id) ON DELETE CASCADE,
    revision BIGINT NOT NULL, document JSONB NOT NULL CHECK(octet_length(document::text)<=24000),
    PRIMARY KEY(rule_id,revision)
  )`.execute(tx);
    await sql `CREATE TABLE slack_summary_rule_events (
    owner_id TEXT NOT NULL, rule_id TEXT NOT NULL REFERENCES slack_summary_rules(rule_id) ON DELETE CASCADE,
    revision BIGINT NOT NULL, message_ts TEXT NOT NULL, event_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(owner_id,rule_id,revision,message_ts), UNIQUE(owner_id,rule_id,revision,event_id)
  )`.execute(tx);
    await sql `CREATE TABLE slack_summary_rule_intents (
    owner_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    args_digest TEXT NOT NULL, receipt JSONB NOT NULL, PRIMARY KEY(owner_id,message_id)
  )`.execute(tx);
}
