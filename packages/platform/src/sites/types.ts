import type { SitePublishing } from '@matrix-os/contracts';
import type { Generated } from 'kysely';
export interface SitesTable {
    id: string;
    owner_id: string;
    machine_id: string;
    app_slug: string;
    title: string;
    description: string;
    slug: string | null;
    revision: number;
    status: 'published' | 'unpublished';
    access_mode: Generated<'public' | 'private_link' | 'private_email'>;
    active_version: string | null;
    created_at: string;
}
export interface SiteVersionsTable {
    id: string;
    site_id: string;
    created_at: string;
    config: SitePublishing;
    files: {
        path: string;
        contentType: string;
        bytes: number;
    }[];
}
export interface SiteAliasesTable {
    slug: string;
    site_id: string | null;
}
export interface SiteAccessLinksTable {
    id: string;
    site_id: string;
    claim_token_hash: string;
    session_token_hash: string | null;
    created_at: string;
    claim_expires_at: string;
    claimed_at: string | null;
    session_expires_at: string | null;
}
export interface SiteEmailInvitationsTable {
    id: string;
    site_id: string;
    normalized_email: string;
    display_email: string;
    generation: Generated<string>;
    state: 'pending' | 'accepted' | 'expired' | 'revoked';
    delivery_state: 'queued' | 'sending' | 'sent' | 'failed' | 'ambiguous' | 'suppressed';
    invited_by_clerk_user_id: string;
    accepted_clerk_user_id: string | null;
    created_at: Date;
    issued_at: Date;
    expires_at: Date;
    accepted_at: Date | null;
    revoked_at: Date | null;
    state_reason: string | null;
    updated_at: Date;
    revision: Generated<string>;
}
export interface SiteViewerGrantsTable {
    id: string;
    site_id: string;
    invitation_id: string;
    invitation_generation: string;
    clerk_user_id: string;
    granted_at: Date;
    revoked_at: Date | null;
    revocation_reason: string | null;
}
export interface SiteViewerSessionsTable {
    id: string;
    site_id: string;
    grant_id: string;
    secret_hash: string;
    clerk_session_key: string;
    created_at: Date;
    expires_at: Date;
    last_seen_at: Date | null;
    revoked_at: Date | null;
}
export interface SiteInvitationDeliveriesTable {
    id: string;
    invitation_id: string;
    invitation_generation: string;
    idempotency_key: string;
    state: 'queued' | 'leased' | 'sent' | 'failed' | 'ambiguous' | 'cancelled';
    attempts: Generated<number>;
    available_at: Date;
    lease_token: string | null;
    lease_until: Date | null;
    provider_message_id: string | null;
    failure_code: string | null;
    sent_at: Date | null;
    created_at: Date;
    updated_at: Date;
}
export interface SiteAccessAuditEventsTable {
    id: string;
    site_id: string;
    invitation_id: string | null;
    event_type: 'invitation_created' | 'invitation_resent' | 'invitation_accepted' | 'invitation_revoked'
        | 'delivery_sent' | 'delivery_failed' | 'grant_revoked' | 'mode_changed' | 'unpublished';
    actor_kind: 'owner' | 'viewer' | 'system';
    actor_reference: string | null;
    details: Record<string, unknown>;
    occurred_at: Date;
}
export interface SiteRecipientLifecycleTable {
    recipient_key: string;
    state: 'active' | 'inactive' | 'deleted';
    last_event_id: string;
    last_event_at: Date;
    updated_at: Date;
}
export interface SiteClerkSessionTerminationsTable {
    clerk_session_key: string;
    terminated_at: Date;
    expires_at: Date;
}
export interface SiteOwner {
    ownerId: string;
    machineId: string;
    appSlug: string;
    authenticatedRuntime?: { handle: string; runtimeSlot: string; runtimeTokenEpoch: number };
}
export class SiteError extends Error {
    constructor(public code: 'conflict' | 'not_found' | 'unavailable' | 'invalid_request') { super(`Site ${code}`); }
}
