/** Two historical v9 identities converge additively; migration history is immutable. */
import { sql, type Transaction } from "kysely";
import { BotSchemaError, type OwnerBotDatabase } from "./database.js";
import { migrateBotChatThreadsV9 } from "./thread-migration.js";
const compact = (value: string) => value.replace(/\s+/g, "");
const THREAD_KIND = "CHECK ((kind = ANY (ARRAY['direct'::text, 'group'::text, 'thread'::text])))";
const THREAD_PROJECT = "CHECK ((((kind = 'thread'::text) = (project_id IS NOT NULL)) AND ((project_id IS NULL) OR (project_id ~ '^proj_[A-Za-z0-9_-]{1,128}$'::text))))";
const SOURCE_RUN = "CHECK (((source_run_id IS NULL) OR (source_run_id ~ '^run_[A-Za-z0-9_-]{1,128}$'::text)))";
async function textColumn(db: Transaction<OwnerBotDatabase>, table: string, column: string) {
  const result = await sql<{ udt_name: string; is_nullable: string; column_default: string | null }>`SELECT udt_name,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=${table} AND column_name=${column}`.execute(db);
  return result.rows.length === 1 && result.rows[0]!.udt_name === "text" && result.rows[0]!.is_nullable === "YES" && result.rows[0]!.column_default === null;
}
async function constraint(db: Transaction<OwnerBotDatabase>, table: string, name: string, expected: string) {
  const result = await sql<{ definition: string }>`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid=${table}::regclass AND conname=${name} AND contype='c' AND convalidated`.execute(db);
  return result.rows.length === 1 && compact(result.rows[0]!.definition) === compact(expected);
}
export async function hasHistoricalThreadSchema(db: Transaction<OwnerBotDatabase>): Promise<boolean> {
  if (!(await textColumn(db,"bot_chat_bindings","project_id"))
    || !(await constraint(db,"bot_chat_bindings","bot_chat_bindings_kind_check",THREAD_KIND))
    || !(await constraint(db,"bot_chat_bindings","bot_chat_bindings_thread_project",THREAD_PROJECT))) return false;
  const indexes = await sql<{ predicate: string; key1: string; key2: string; key3: string }>`SELECT pg_get_expr(indpred,indrelid) AS predicate,
    pg_get_indexdef(indexrelid,1,true) AS key1,pg_get_indexdef(indexrelid,2,true) AS key2,pg_get_indexdef(indexrelid,3,true) AS key3
    FROM pg_index JOIN pg_class ON pg_class.oid=indexrelid WHERE indrelid='bot_chat_bindings'::regclass
    AND relname='idx_bot_chat_bindings_threads' AND indisvalid AND indisready AND NOT indisunique AND indnatts=3 AND indnkeyatts=3`.execute(db);
  const row=indexes.rows[0];
  return indexes.rows.length===1 && row?.key1==="owner_id" && row.key2==="bot_id" && row.key3==="project_id"
    && typeof row.predicate === "string" && compact(row.predicate)===compact("((kind = 'thread'::text) AND (removed_at IS NULL))");
}
export async function migrateBotQuestionSourceV9(db: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql`ALTER TABLE bot_interactions ADD COLUMN source_run_id TEXT
    CHECK (source_run_id IS NULL OR source_run_id ~ '^run_[A-Za-z0-9_-]{1,128}$')`.execute(db);
}
export async function migrateBotQuestionThreadsV10(db: Transaction<OwnerBotDatabase>): Promise<void> {
  const recorded=await db.selectFrom("bot_schema_migrations").select("name").where("version","=",9).executeTakeFirstOrThrow();
  if(recorded.name==="bot_chat_threads") {
    if(!(await hasHistoricalThreadSchema(db))) throw new BotSchemaError("invalid_migrations");
    await migrateBotQuestionSourceV9(db);
  } else if(recorded.name==="question_source_run") {
    if(!(await textColumn(db,"bot_interactions","source_run_id"))
      || !(await constraint(db,"bot_interactions","bot_interactions_source_run_id_check",SOURCE_RUN))) throw new BotSchemaError("invalid_migrations");
    await migrateBotChatThreadsV9(db);
  } else throw new BotSchemaError("invalid_migrations");
}
