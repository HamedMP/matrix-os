import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "../database/migration-types.js";

/** Independent scope: a candidate core schema generation never suppresses pair setup. */
export async function migratePreviewPairs(db: PlatformMigrationExecutor): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS preview_pairs (
    pair_id TEXT PRIMARY KEY,
    repository TEXT NOT NULL CHECK (repository = 'HamedMP/matrix-os'),
    pr INTEGER NOT NULL CHECK (pr BETWEEN 1 AND 999999999),
    requester_id TEXT NOT NULL,
    source_sha TEXT NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 999),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','preparing','ready','updating','failed','cleanup_pending','stopped')),
    outdated BOOLEAN NOT NULL DEFAULT FALSE,
    fixture_id TEXT,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK (expires_at > created_at),
    requested_source_sha TEXT, failure_code TEXT,
    claim_id TEXT, claim_expires_at TEXT,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    next_attempt_at TEXT, stopped_at TEXT,
    CHECK ((claim_id IS NULL) = (claim_expires_at IS NULL)),
    CHECK ((state = 'stopped') = (stopped_at IS NOT NULL))
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS preview_pairs_active_pr
    ON preview_pairs(repository, pr) WHERE state <> 'stopped'`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS preview_pairs_reconcile
    ON preview_pairs(state, next_attempt_at, expires_at)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS preview_pair_fixtures (
    fixture_id TEXT PRIMARY KEY,
    owner_actor_id TEXT NOT NULL UNIQUE,
    member_actor_id TEXT NOT NULL UNIQUE,
    outsider_actor_id TEXT NOT NULL,
    organization_id TEXT NOT NULL UNIQUE,
    active_pair_id TEXT UNIQUE REFERENCES preview_pairs(pair_id),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    CHECK (owner_actor_id <> member_actor_id AND outsider_actor_id <> owner_actor_id AND outsider_actor_id <> member_actor_id)
  )`.execute(db);
  await sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'preview_pairs_fixture_fk' AND conrelid = 'preview_pairs'::regclass) THEN
      ALTER TABLE preview_pairs ADD CONSTRAINT preview_pairs_fixture_fk
        FOREIGN KEY (fixture_id) REFERENCES preview_pair_fixtures(fixture_id);
    END IF;
  END $$`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS preview_pair_generations (
    pair_id TEXT NOT NULL REFERENCES preview_pairs(pair_id),
    generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 999),
    source_sha TEXT NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
    candidate JSONB,
    data_policy TEXT NOT NULL DEFAULT 'reset' CHECK (data_policy = 'reset'),
    created_at TEXT NOT NULL, ready_at TEXT, retired_at TEXT,
    PRIMARY KEY (pair_id, generation)
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS preview_pair_members (
    pair_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','member')),
    actor_id TEXT NOT NULL,
    machine_id TEXT NOT NULL UNIQUE REFERENCES user_machines(machine_id),
    job_id TEXT NOT NULL UNIQUE REFERENCES provisioning_jobs(job_id),
    handle TEXT NOT NULL UNIQUE CHECK (char_length(handle) <= 32),
    observation JSONB,
    retired_at TEXT, provider_absent_at TEXT,
    PRIMARY KEY (pair_id, generation, role),
    FOREIGN KEY (pair_id, generation) REFERENCES preview_pair_generations(pair_id, generation),
    CHECK (provider_absent_at IS NULL OR retired_at IS NOT NULL)
  )`.execute(db);
}

export async function migratePreviewPairController(db: PlatformMigrationExecutor): Promise<void> {
  await migratePreviewPairs(db);
  await sql`ALTER TABLE preview_pair_generations ADD COLUMN IF NOT EXISTS controller_run_id BIGINT
    CHECK (controller_run_id BETWEEN 1 AND 9007199254740991)`.execute(db);
}

export async function migratePreviewPairCloudIntents(db: PlatformMigrationExecutor): Promise<void> {
  await migratePreviewPairController(db);
  await sql`CREATE TABLE IF NOT EXISTS preview_pair_cloud_intents (
    pair_id TEXT NOT NULL CHECK (pair_id ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
    generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 999),
    pr INTEGER NOT NULL CHECK (pr BETWEEN 1 AND 999999999),
    requester_id TEXT NOT NULL,
    source_sha TEXT NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
    controller_run_id BIGINT NOT NULL CHECK (controller_run_id BETWEEN 1 AND 9007199254740991),
    profile_fingerprint TEXT NOT NULL CHECK (profile_fingerprint ~ '^[a-f0-9]{64}$'),
    state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','adopted','cleanup_pending','stopped')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK (expires_at > created_at), stopped_at TEXT,
    PRIMARY KEY (pair_id, generation),
    CHECK ((state = 'stopped') = (stopped_at IS NOT NULL))
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS preview_pair_cloud_intents_reconcile
    ON preview_pair_cloud_intents(state, expires_at)`.execute(db);
}

export async function migratePreviewPairPublication(db: PlatformMigrationExecutor): Promise<void> {
  await migratePreviewPairCloudIntents(db);
  await sql`ALTER TABLE preview_pair_cloud_intents
    ADD COLUMN IF NOT EXISTS claim_id TEXT,
    ADD COLUMN IF NOT EXISTS claim_expires_at TEXT,
    ADD COLUMN IF NOT EXISTS next_attempt_at TEXT,
    ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    ADD COLUMN IF NOT EXISTS failure_code TEXT,
    ADD COLUMN IF NOT EXISTS publication_id TEXT,
    ADD COLUMN IF NOT EXISTS publication_state TEXT NOT NULL DEFAULT 'unissued'
      CHECK (publication_state IN ('unissued','issuing','accepted','rejected')),
    ADD COLUMN IF NOT EXISTS operation_name TEXT CHECK (char_length(operation_name) <= 256)`.execute(db);
  await sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preview_pair_intent_claim_pair'
      AND conrelid = 'preview_pair_cloud_intents'::regclass) THEN
      ALTER TABLE preview_pair_cloud_intents ADD CONSTRAINT preview_pair_intent_claim_pair
        CHECK ((claim_id IS NULL) = (claim_expires_at IS NULL));
      ALTER TABLE preview_pair_cloud_intents ADD CONSTRAINT preview_pair_intent_publication_shape CHECK (
        (publication_state = 'unissued' AND publication_id IS NULL AND operation_name IS NULL) OR
        (publication_state IN ('issuing','rejected') AND publication_id IS NOT NULL AND operation_name IS NULL) OR
        (publication_state = 'accepted' AND publication_id IS NOT NULL AND operation_name IS NOT NULL));
    END IF;
  END $$`.execute(db);
}

export async function migratePreviewPairPublisher(db: PlatformMigrationExecutor): Promise<void> {
  await migratePreviewPairPublication(db);
  // Legacy pending journals remain retireable; admission requires a new pinned
  // image receipt, never a guessed backfill for an earlier ambiguous effect.
  await sql`ALTER TABLE preview_pair_cloud_intents ADD COLUMN IF NOT EXISTS image_sha256 TEXT
    CHECK (image_sha256 ~ '^[a-f0-9]{64}$')`.execute(db);
}
