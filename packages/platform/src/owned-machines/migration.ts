import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../database/migration-types.js';

/**
 * Spec 2707: owned machines are user_machines rows with substrate 'owned' and
 * provisioning_class 'owned'. Their tunnel and heartbeat state lives in
 * owned_machine_links; enrollment codes live in owned_machine_enrollments.
 * Machine credentials are HMAC-derived from runtime_token_epoch, so no secret
 * is stored here.
 *
 * Independently versioned (scope 'owned-machines'), so it does not race the
 * core schema generation on shared preview databases. Runs after core because
 * it widens user_machines checks. Bump OWNED_MACHINES_SCHEMA_REVISION when the
 * DDL below changes.
 */
export const OWNED_MACHINES_SCHEMA_REVISION = { generation: 2, fingerprint: 'owned-machines-v2' } as const;

export async function migrateOwnedMachines(db: PlatformMigrationExecutor): Promise<void> {
  // Widen the existing checks by adding 'owned' to whatever values they already
  // allow. Shared preview databases may carry values from other branches, so
  // the allowed set is extended, never replaced, and existing rows are not rescanned.
  await sql`
    DO $$
    DECLARE
      target RECORD;
      existing TEXT;
      allowed TEXT[];
    BEGIN
      FOR target IN SELECT * FROM (VALUES
        ('user_machines_substrate_check', 'substrate', ARRAY['vps', 'container']),
        ('user_machines_provisioning_class_check', 'provisioning_class', ARRAY['customer', 'preview', 'private-preview'])
      ) AS t(name, col, defaults)
      LOOP
        SELECT pg_get_constraintdef(oid) INTO existing FROM pg_constraint
        WHERE conrelid = 'user_machines'::regclass AND conname = target.name;
        IF existing IS NOT NULL AND existing LIKE '%''owned''%' THEN CONTINUE; END IF;
        IF existing IS NULL THEN
          allowed := target.defaults;
        ELSE
          SELECT array_agg(DISTINCT m[1]) INTO allowed FROM regexp_matches(existing, '''([A-Za-z0-9_-]+)''', 'g') AS m;
        END IF;
        allowed := array_append(COALESCE(allowed, target.defaults), 'owned');
        EXECUTE format('ALTER TABLE user_machines DROP CONSTRAINT IF EXISTS %I', target.name);
        -- An IN list keeps Postgres' ARRAY['x'::text, ...] rendering, which the
        -- 'owned' check above and the value extraction both read.
        EXECUTE format('ALTER TABLE user_machines ADD CONSTRAINT %I CHECK (%I IN (%s)) NOT VALID',
          target.name, target.col, (SELECT string_agg(quote_literal(v), ', ') FROM unnest(allowed) AS v));
      END LOOP;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'user_machines'::regclass
          AND conname = 'user_machines_owned_shape_check'
      ) THEN
        ALTER TABLE user_machines ADD CONSTRAINT user_machines_owned_shape_check
          CHECK (
            (substrate = 'owned') = (provisioning_class = 'owned')
            AND (substrate <> 'owned' OR (runtime_slot ~ '^owned-[0-9a-f]{8}$' AND hetzner_server_id IS NULL))
          ) NOT VALID;
      END IF;
    END $$
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS owned_machine_links (
      machine_id TEXT PRIMARY KEY REFERENCES user_machines(machine_id) ON DELETE CASCADE,
      clerk_user_id TEXT NOT NULL,
      display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 64),
      tunnel_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (tunnel_state IN ('pending', 'ready', 'reclaimed', 'deleting', 'deleted', 'failed')),
      tunnel_id TEXT,
      tunnel_hostname TEXT UNIQUE,
      tunnel_attempts INTEGER NOT NULL DEFAULT 0 CHECK (tunnel_attempts >= 0),
      tunnel_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      tunnel_claim_id TEXT,
      reported_hostname TEXT,
      reported_os TEXT,
      reported_arch TEXT CHECK (reported_arch IS NULL OR reported_arch IN ('x86_64', 'arm64')),
      agent_version TEXT,
      last_heartbeat_at TIMESTAMPTZ,
      auto_security_updates BOOLEAN NOT NULL DEFAULT true,
      backups_enabled BOOLEAN NOT NULL DEFAULT false,
      paired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_owned_machine_links_owner_active
    ON owned_machine_links(clerk_user_id) WHERE revoked_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_owned_machine_links_tunnel_work
    ON owned_machine_links(tunnel_state, tunnel_next_attempt_at)
    WHERE tunnel_state IN ('pending', 'deleting')
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS owned_machine_enrollments (
      enrollment_id TEXT PRIMARY KEY,
      device_code_hash TEXT NOT NULL UNIQUE,
      user_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'delivered', 'denied', 'expired')),
      reported_hostname TEXT NOT NULL,
      reported_os TEXT NOT NULL,
      reported_arch TEXT NOT NULL CHECK (reported_arch IN ('x86_64', 'arm64')),
      agent_version TEXT NOT NULL,
      source_key TEXT NOT NULL,
      clerk_user_id TEXT,
      machine_id TEXT REFERENCES user_machines(machine_id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      approved_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      last_polled_at TIMESTAMPTZ
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_owned_machine_enrollments_pending_code
    ON owned_machine_enrollments(user_code) WHERE status = 'pending'
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_owned_machine_enrollments_source
    ON owned_machine_enrollments(source_key, created_at)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_owned_machine_enrollments_owner
    ON owned_machine_enrollments(clerk_user_id, approved_at) WHERE clerk_user_id IS NOT NULL
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_owned_machine_enrollments_expiry ON owned_machine_enrollments(expires_at)`.execute(db);
}
