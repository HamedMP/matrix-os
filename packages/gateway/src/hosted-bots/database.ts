import { sql, type Kysely } from "kysely";
import type { RunMode, RunStatus } from "./contracts.js";

export interface HostedBotsDatabase {
  hosted_bots: { owner_id: string; id: string; name: string; instructions: string; revision: number };
  hosted_bot_threads: { owner_id: string; bot_id: string; id: string; title: string; updated_at: Date };
  hosted_bot_runs: {
    owner_id: string; bot_id: string; thread_id: string; id: string; request_id: string; mode: RunMode;
    input: string; output: string | null; status: RunStatus; created_at: Date; completed_at: Date | null; lease_until: Date | null;
  };
  hosted_bot_changes: {
    owner_id: string; bot_id: string; thread_id: string; id: string;
    prior: string; reason: string; revision: number; undone_at: Date | null;
  };
}

export async function ensureHostedBotsSchema(db: Kysely<HostedBotsDatabase>) {
  await db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(371820055)`.execute(tx);
    await sql`create table if not exists hosted_bots (
      owner_id text not null, id uuid not null, name text not null,
      instructions text not null, revision integer not null,
      primary key(owner_id, id)
    )`.execute(tx);
    await sql`create table if not exists hosted_bot_threads (
      owner_id text not null, bot_id uuid not null, id uuid not null,
      title text not null, updated_at timestamptz not null,
      primary key(owner_id, bot_id, id),
      foreign key(owner_id, bot_id) references hosted_bots(owner_id, id)
    )`.execute(tx);
    await sql`create table if not exists hosted_bot_runs (
      owner_id text not null, bot_id uuid not null, thread_id uuid not null, id uuid primary key,
      request_id uuid not null, mode text not null check (mode in ('chat','setup')),
      input text not null, output text, status text not null check (status in ('queued','running','completed','failed')),
      created_at timestamptz not null, completed_at timestamptz, lease_until timestamptz,
      unique(owner_id, bot_id, thread_id, request_id),
      foreign key(owner_id, bot_id, thread_id) references hosted_bot_threads(owner_id, bot_id, id)
    )`.execute(tx);
    await sql`create index if not exists hosted_bot_runs_thread on hosted_bot_runs(owner_id, bot_id, thread_id, created_at)`.execute(tx);
    await sql`create index if not exists hosted_bot_runs_active on hosted_bot_runs(status, created_at, lease_until) where status in ('queued','running')`.execute(tx);
    await sql`create unique index if not exists hosted_bot_runs_one_active on hosted_bot_runs(owner_id, bot_id) where status in ('queued','running')`.execute(tx);
    await sql`create table if not exists hosted_bot_changes (
      owner_id text not null, bot_id uuid not null, thread_id uuid not null, id uuid primary key,
      prior text not null, reason text not null, revision integer not null, undone_at timestamptz,
      unique(owner_id, bot_id, revision),
      foreign key(owner_id, bot_id, thread_id) references hosted_bot_threads(owner_id, bot_id, id)
    )`.execute(tx);
  });
}
