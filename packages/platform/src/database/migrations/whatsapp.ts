import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

export async function migrateWhatsApp(db: PlatformMigrationExecutor): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS whatsapp_connections (
    id TEXT NOT NULL UNIQUE,
    owner TEXT PRIMARY KEY,
    sender TEXT NOT NULL UNIQUE,
    chat_id TEXT,
    machine_id TEXT,
    consent_version TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    CHECK ((chat_id IS NULL) = (machine_id IS NULL))
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS whatsapp_link_challenges (
    token_hash TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    sender TEXT NOT NULL,
    token_cipher TEXT NOT NULL,
    owner TEXT,
    code_hash TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('open', 'claimed', 'consumed', 'blocked')),
    expires_at DOUBLE PRECISION NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_whatsapp_links_sender ON whatsapp_link_challenges(sender)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_whatsapp_links_expiry ON whatsapp_link_challenges(expires_at)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS whatsapp_jobs (
    id TEXT PRIMARY KEY,
    sequence BIGSERIAL NOT NULL UNIQUE,
    sender TEXT NOT NULL,
    payload TEXT,
    state TEXT NOT NULL CHECK (state IN ('ready','leased','sending','complete','failed','unknown','expired','revoked')),
    attempts INTEGER NOT NULL DEFAULT 0,
    fence TEXT,
    lease_expires_at DOUBLE PRECISION,
    available_at DOUBLE PRECISION NOT NULL,
    expires_at DOUBLE PRECISION NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    finished_at DOUBLE PRECISION
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_whatsapp_jobs_claim ON whatsapp_jobs(state,available_at,sequence)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_whatsapp_jobs_sender ON whatsapp_jobs(sender,sequence)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_whatsapp_jobs_expiry ON whatsapp_jobs(expires_at)`.execute(db);
}
