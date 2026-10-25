import { sql, type Kysely } from "kysely";
import { boundedProvenanceTransaction } from "../google-data/provenance/transaction.js";
import { lockGoogleContexts } from "../google-data/runtime/contexts-schema.js";

/** Metadata only. Host owns migration ordering and the injected owner database. */
export async function migrateChatAnalytics<DB>(db: Kysely<DB>) {
  await boundedProvenanceTransaction(db, async tx => {
    await lockGoogleContexts(tx);
    await sql`CREATE TABLE IF NOT EXISTS chat_analytics_owner_policy (
      owner_id TEXT PRIMARY KEY CHECK(char_length(owner_id) BETWEEN 1 AND 160), enabled BOOLEAN NOT NULL DEFAULT false,
      sample_rate_bp INTEGER NOT NULL CHECK(sample_rate_bp BETWEEN 0 AND 10000), policy_epoch UUID NOT NULL)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS chat_analytics_scopes (
      owner_id TEXT NOT NULL REFERENCES chat_analytics_owner_policy(owner_id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, scope_epoch UUID NOT NULL, PRIMARY KEY(owner_id,chat_id))`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS chat_analytics_generations (
      generation_id UUID PRIMARY KEY, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE, runtime_handle TEXT NOT NULL,
      execution_generation TEXT NOT NULL, request_id TEXT NOT NULL, owner_epoch UUID NOT NULL, chat_epoch UUID NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      sample_rate_bp INTEGER NOT NULL CHECK(sample_rate_bp BETWEEN 0 AND 10000), sampled BOOLEAN NOT NULL,
      facts JSONB NOT NULL CHECK(jsonb_typeof(facts)='object' AND (facts-ARRAY['completedAt','modelId','harness','accessSource','inputTokens','outputTokens','cachedInputTokens','costUsd','latencyMs'])='{}'::jsonb),
      task_family TEXT, task_type TEXT, complexity TEXT CHECK(complexity IN ('low','medium','high')),
      confidence_self_reported DOUBLE PRECISION CHECK(confidence_self_reported BETWEEN 0 AND 1),
      taxonomy_version INTEGER CHECK(taxonomy_version=1), classified_at TIMESTAMPTZ,
      FOREIGN KEY(owner_id,chat_id) REFERENCES chat_analytics_scopes(owner_id,chat_id) ON DELETE CASCADE,
      UNIQUE(owner_id,chat_id,run_id,runtime_handle,execution_generation,request_id))`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS chat_analytics_owner_completed ON chat_analytics_generations(owner_id,completed_at)`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS chat_analytics_expiry ON chat_analytics_generations(expires_at)`.execute(tx);
  });
}
