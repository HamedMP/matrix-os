import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../database/migration-types.js';
export async function migrateSites(db: PlatformMigrationExecutor): Promise<void> {
    await sql `CREATE TABLE IF NOT EXISTS public_sites (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, machine_id TEXT NOT NULL, app_slug TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL, slug TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), status TEXT NOT NULL CHECK (status IN ('published','unpublished')),
  active_version TEXT, created_at TEXT NOT NULL, UNIQUE(owner_id,machine_id,app_slug)
 )`.execute(db);
    await sql `ALTER TABLE public_sites ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'public'
      CHECK (access_mode IN ('public','private_link'))`.execute(db);
    await sql `CREATE TABLE IF NOT EXISTS public_site_versions (
  id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES public_sites(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, config JSONB NOT NULL, files JSONB NOT NULL
 )`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_versions_site ON public_site_versions(site_id,created_at)`.execute(db);
    // Prior aliases remain owned by the site to prevent link takeover.
    await sql `CREATE TABLE IF NOT EXISTS public_site_aliases (
  slug TEXT PRIMARY KEY, site_id TEXT REFERENCES public_sites(id) ON DELETE SET NULL
 )`.execute(db);
    await sql `CREATE TABLE IF NOT EXISTS public_site_access_links (
  id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES public_sites(id) ON DELETE CASCADE,
  claim_token_hash TEXT NOT NULL CHECK (claim_token_hash ~ '^[a-f0-9]{64}$'),
  session_token_hash TEXT CHECK (session_token_hash IS NULL OR session_token_hash ~ '^[a-f0-9]{64}$'),
  created_at TEXT NOT NULL, claim_expires_at TEXT NOT NULL,
  claimed_at TEXT, session_expires_at TEXT,
  CHECK ((claimed_at IS NULL AND session_token_hash IS NULL AND session_expires_at IS NULL)
    OR (claimed_at IS NOT NULL AND session_token_hash IS NOT NULL AND session_expires_at IS NOT NULL))
 )`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_access_links_site
      ON public_site_access_links(site_id,created_at,id)`.execute(db);
    // Generation 2 installed this named check through ADD COLUMN. Replacing it
    // explicitly is required for existing publications; IF NOT EXISTS alone
    // would leave the old two-mode constraint in place.
    await sql `ALTER TABLE public_sites DROP CONSTRAINT IF EXISTS public_sites_access_mode_check`.execute(db);
    await sql `ALTER TABLE public_sites ADD CONSTRAINT public_sites_access_mode_check
      CHECK (access_mode IN ('public','private_link','private_email'))`.execute(db);
    await sql `CREATE TABLE IF NOT EXISTS public_site_email_invitations (
      id UUID PRIMARY KEY, site_id TEXT NOT NULL REFERENCES public_sites(id) ON DELETE CASCADE,
      normalized_email TEXT NOT NULL CHECK (length(normalized_email) BETWEEN 3 AND 254),
      display_email TEXT NOT NULL CHECK (length(display_email) BETWEEN 3 AND 254),
      generation BIGINT NOT NULL DEFAULT 1 CHECK (generation >= 1),
      state TEXT NOT NULL,
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('queued','sending','sent','failed','ambiguous','suppressed')),
      invited_by_clerk_user_id TEXT NOT NULL CHECK (length(invited_by_clerk_user_id) BETWEEN 1 AND 255),
      accepted_clerk_user_id TEXT CHECK (accepted_clerk_user_id IS NULL OR length(accepted_clerk_user_id) BETWEEN 1 AND 255),
      created_at TIMESTAMPTZ NOT NULL, issued_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at),
      accepted_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
      state_reason TEXT CHECK (state_reason IS NULL OR state_reason IN
        ('owner','duplicate_identity','mode_changed','unpublished','recipient_inactive','recipient_deleted','reinvited')),
      updated_at TIMESTAMPTZ NOT NULL, revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
      CONSTRAINT public_site_email_invitations_site_email_key UNIQUE (site_id, normalized_email),
      CONSTRAINT public_site_email_invitations_state_check CHECK (
        (state = 'pending' AND accepted_clerk_user_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
        OR (state = 'accepted' AND accepted_clerk_user_id IS NOT NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL)
        OR (state = 'expired' AND accepted_clerk_user_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
        OR (state = 'revoked' AND revoked_at IS NOT NULL))
    )`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_email_invitations_inventory_idx
      ON public_site_email_invitations(site_id,updated_at DESC,id DESC)`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_email_invitations_recipient_idx
      ON public_site_email_invitations(accepted_clerk_user_id) WHERE accepted_clerk_user_id IS NOT NULL`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_email_invitations_expiry_idx
      ON public_site_email_invitations(expires_at,id) WHERE state = 'pending'`.execute(db);
    await sql `CREATE TABLE IF NOT EXISTS public_site_viewer_grants (
      id UUID PRIMARY KEY, site_id TEXT NOT NULL REFERENCES public_sites(id) ON DELETE CASCADE,
      invitation_id UUID NOT NULL REFERENCES public_site_email_invitations(id) ON DELETE CASCADE,
      invitation_generation BIGINT NOT NULL CHECK (invitation_generation >= 1),
      clerk_user_id TEXT NOT NULL CHECK (length(clerk_user_id) BETWEEN 1 AND 255),
      granted_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
      revocation_reason TEXT CHECK (revocation_reason IS NULL OR revocation_reason IN
        ('owner','mode_changed','unpublished','owner_deleted','recipient_deleted','recipient_inactive','reinvited')),
      CONSTRAINT public_site_viewer_grants_invitation_generation_key UNIQUE (invitation_id,invitation_generation),
      CHECK ((revoked_at IS NULL AND revocation_reason IS NULL) OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
    )`.execute(db);
    await sql `CREATE UNIQUE INDEX IF NOT EXISTS public_site_viewer_grants_one_active_identity_idx
      ON public_site_viewer_grants(site_id,clerk_user_id) WHERE revoked_at IS NULL`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_viewer_grants_recipient_idx
      ON public_site_viewer_grants(clerk_user_id,revoked_at)`.execute(db);
    await sql `CREATE TABLE IF NOT EXISTS public_site_viewer_sessions (
      id UUID PRIMARY KEY, site_id TEXT NOT NULL REFERENCES public_sites(id) ON DELETE CASCADE,
      grant_id UUID NOT NULL REFERENCES public_site_viewer_grants(id) ON DELETE CASCADE,
      secret_hash CHAR(64) NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
      clerk_session_key CHAR(64) NOT NULL CHECK (clerk_session_key ~ '^[a-f0-9]{64}$'),
      created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
      CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days')
    )`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_viewer_sessions_site_idx
      ON public_site_viewer_sessions(site_id,id)`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_viewer_sessions_grant_idx
      ON public_site_viewer_sessions(grant_id,revoked_at)`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_viewer_sessions_clerk_session_idx
      ON public_site_viewer_sessions(clerk_session_key,revoked_at)`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_viewer_sessions_expiry_idx
      ON public_site_viewer_sessions(expires_at,id)`.execute(db);
    await sql `CREATE TABLE IF NOT EXISTS public_site_recipient_lifecycle (
      recipient_key CHAR(64) PRIMARY KEY CHECK (recipient_key ~ '^[a-f0-9]{64}$'),
      state TEXT NOT NULL CHECK (state IN ('active','inactive','deleted')),
      last_event_id TEXT NOT NULL CHECK (length(last_event_id) BETWEEN 1 AND 255),
      last_event_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    )`.execute(db);
    await sql `CREATE TABLE IF NOT EXISTS public_site_clerk_session_terminations (
      clerk_session_key CHAR(64) PRIMARY KEY CHECK (clerk_session_key ~ '^[a-f0-9]{64}$'),
      terminated_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      CHECK (expires_at >= terminated_at + interval '30 days')
    )`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_clerk_session_terminations_expiry_idx
      ON public_site_clerk_session_terminations(expires_at)`.execute(db);
    await sql `CREATE TABLE IF NOT EXISTS public_site_invitation_deliveries (
      id UUID PRIMARY KEY, invitation_id UUID NOT NULL REFERENCES public_site_email_invitations(id) ON DELETE CASCADE,
      invitation_generation BIGINT NOT NULL CHECK (invitation_generation >= 1),
      idempotency_key UUID NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('queued','leased','sent','failed','ambiguous','cancelled')),
      attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
      available_at TIMESTAMPTZ NOT NULL, lease_token UUID, lease_until TIMESTAMPTZ,
      provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 255),
      failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN
        ('configuration','throttled','rejected','timeout','unavailable','unknown')),
      sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT public_site_invitation_deliveries_generation_key UNIQUE (invitation_id,invitation_generation),
      CHECK ((state = 'leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
        OR (state <> 'leased' AND lease_token IS NULL AND lease_until IS NULL))
    )`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_invitation_deliveries_claim_idx
      ON public_site_invitation_deliveries(state,available_at,created_at)`.execute(db);
    await sql `CREATE TABLE IF NOT EXISTS public_site_access_audit_events (
      id UUID PRIMARY KEY, site_id TEXT NOT NULL REFERENCES public_sites(id) ON DELETE CASCADE,
      invitation_id UUID REFERENCES public_site_email_invitations(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL CHECK (event_type IN
        ('invitation_created','invitation_resent','invitation_accepted','invitation_revoked',
         'delivery_sent','delivery_failed','grant_revoked','mode_changed','unpublished')),
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','viewer','system')),
      actor_reference TEXT CHECK (actor_reference IS NULL OR length(actor_reference) <= 255),
      details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK
        (jsonb_typeof(details) = 'object' AND details - 'generation' - 'reason' - 'fromMode' - 'toMode' = '{}'::jsonb),
      occurred_at TIMESTAMPTZ NOT NULL
    )`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS public_site_access_audit_events_site_idx
      ON public_site_access_audit_events(site_id,occurred_at DESC,id DESC)`.execute(db);
}
