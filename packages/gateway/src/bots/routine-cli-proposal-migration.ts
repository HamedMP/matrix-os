import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "./database.js";
/** Correlation survives admission/response loss; historical app receipts remain immutable. */
export async function migrateRoutineCliProposalsV15(tx: Transaction<OwnerBotDatabase>) {
  await sql`CREATE TABLE routine_cli_proposals (
    owner_id TEXT NOT NULL, computer_id TEXT NOT NULL, client_request_id UUID NOT NULL,
    canonical_request_id TEXT NOT NULL UNIQUE CHECK (canonical_request_id ~ '^req_cli_routine_[a-f0-9]{32}$'),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    stage TEXT NOT NULL CHECK (stage IN ('reserved','submitting','canonical_queued','canonical_accepted','target_task_claimed','pending_approval','rejected','unknown')),
    run_id TEXT, task_id TEXT, interaction_id TEXT, runtime_handle TEXT, execution_generation TEXT,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(owner_id,computer_id,client_request_id),
    FOREIGN KEY(owner_id,computer_id,client_request_id) REFERENCES routine_cli_requests(owner_id,computer_id,client_request_id) DEFERRABLE INITIALLY DEFERRED,
    CHECK ((stage NOT IN ('target_task_claimed','pending_approval')) OR (run_id IS NOT NULL AND task_id IS NOT NULL)),
    CHECK (stage <> 'pending_approval' OR (interaction_id IS NOT NULL AND runtime_handle IS NOT NULL AND execution_generation IS NOT NULL))
  )`.execute(tx);
}
