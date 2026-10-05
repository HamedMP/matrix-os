import { sql, type Kysely } from "kysely";
export interface MemoryDatabase {
  memory_workspace_sources: {
    id: string;
    owner_id: string;
    external_id: string;
    title: string;
    content: string;
    kind: string;
    collection: string;
    revision: number;
    content_hash: string;
    metadata: unknown;
    occurred_at: Date | null;
    updated_at: Date;
    deleted_at: Date | null;
  };
}
export async function bootstrapMemoryDatabase(
  db: Kysely<MemoryDatabase>,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`CREATE TABLE IF NOT EXISTS memory_workspace_owners (owner_id TEXT PRIMARY KEY)`.execute(
      trx,
    );
    await sql`CREATE TABLE IF NOT EXISTS memory_workspace_sources (
 id UUID PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES memory_workspace_owners(owner_id), external_id TEXT NOT NULL,
 title TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('note','email','calendar','document')),
 collection TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), content_hash TEXT NOT NULL,
 metadata JSONB NOT NULL DEFAULT '{}', occurred_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ,
 UNIQUE(owner_id,external_id))`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS memory_workspace_imports (
 owner_id TEXT NOT NULL REFERENCES memory_workspace_owners(owner_id), request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 source_ids JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,request_id))`.execute(
      trx,
    );
    await sql`CREATE TABLE IF NOT EXISTS memory_workspace_jobs (
 id UUID PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES memory_workspace_owners(owner_id), source_id UUID NOT NULL REFERENCES memory_workspace_sources(id),
 engine TEXT NOT NULL CHECK(engine IN ('hindsight','openviking')), revision INTEGER NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
 status TEXT NOT NULL CHECK(status IN ('pending','processing','ready','failed','cancelled')), attempts INTEGER NOT NULL DEFAULT 0,
 lease_token UUID, lease_until TIMESTAMPTZ, available_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(source_id,engine,revision,operation))`.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS memory_workspace_jobs_claim ON memory_workspace_jobs(engine,status,available_at)`.execute(
      trx,
    );
    await sql`ALTER TABLE memory_workspace_sources ADD COLUMN IF NOT EXISTS search_text TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple',title||' '||content)) STORED`.execute(
      trx,
    );
    await sql`CREATE INDEX IF NOT EXISTS memory_workspace_sources_search ON memory_workspace_sources USING GIN(search_text)`.execute(
      trx,
    );
    await sql`CREATE TABLE IF NOT EXISTS memory_workspace_comparisons (id UUID PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES memory_workspace_owners(owner_id),query TEXT NOT NULL,results JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`.execute(
      trx,
    );
    await sql`CREATE INDEX IF NOT EXISTS memory_workspace_comparisons_owner ON memory_workspace_comparisons(owner_id,created_at DESC)`.execute(
      trx,
    );
    await sql`CREATE INDEX IF NOT EXISTS memory_workspace_sources_owner ON memory_workspace_sources(owner_id,updated_at DESC)`.execute(
      trx,
    );
  });
}
