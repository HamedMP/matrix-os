/**
 * Email invitations for Matrix.page (`private_email` access mode, spec 2691).
 *
 * STUB: the real backend ships in the unmerged 2691 stack (#3233–#3340). This
 * adapter mirrors that contract (specs/2691-email-app-invitations/contracts/
 * http-api.openapi.yaml on the stack) so the Private tab can be built and
 * tested now. Only an in-memory fake exists here, and it is gated behind
 * `NEXT_PUBLIC_MATRIX_SHARE_EMAIL_INVITES_PREVIEW=1` (or the Electron
 * equivalent) so production users never see invitations that send nothing.
 *
 * TODO(2691): after #3233–#3340 merge, add `createSiteEmailInvitationAdapter`
 * backed by the site client (`emailInvitations`, `createEmailInvitations`,
 * `resendEmailInvitation`, `revokeEmailInvitation`) and switch modes with
 * `PATCH /api/apps/:slug/site { accessMode: "private_email" }`. Do not
 * reimplement the 2691 backend or its viewer auth flow here.
 */

/** Matches 2691 `InvitationSummary.state`. */
export type EmailInvitationState = "pending" | "accepted" | "expired" | "revoked";

/** Subset of 2691 `InvitationSummary` the share UI renders. */
export interface EmailInvitationSummary {
  id: string;
  emailAddress: string;
  state: EmailInvitationState;
  /** Optimistic concurrency token for resend/revoke (2691 `revision`). */
  revision: number;
  issuedAt: string;
  expiresAt: string;
}

export interface EmailInvitationPage { invitations: EmailInvitationSummary[]; siteRevision: number }

/** 2691 `results[]` entry. */
export type EmailInvitationResult =
  | { inputIndex: number; outcome: "queued" | "existing"; invitation: EmailInvitationSummary }
  | { inputIndex: number; outcome: "invalid" | "duplicate_in_batch" | "policy_rejected" };

export interface EmailInvitationAdapter {
  /** `preview` = in-memory fake; `live` = real 2691 API (not wired yet). */
  readonly kind: "preview" | "live";
  /** Whether `private_email` is the active Matrix.page access mode. */
  active(appSlug: string): boolean;
  /**
   * Make `private_email` the access mode. The caller has already confirmed any
   * mode switch; the previous mode's access must stop before this resolves.
   */
  activate(appSlug: string, signal: AbortSignal): Promise<void>;
  /** Leave `private_email`; all invitations and grants are revoked for good. */
  deactivate(appSlug: string, signal: AbortSignal): Promise<void>;
  list(appSlug: string, signal: AbortSignal): Promise<EmailInvitationPage>;
  invite(appSlug: string, value: { emailAddresses: string[]; baseRevision: number }, signal: AbortSignal): Promise<{ results: EmailInvitationResult[]; siteRevision: number }>;
  resend(appSlug: string, id: string, value: { baseRevision: number; invitationRevision: number }, signal: AbortSignal): Promise<{ invitation: EmailInvitationSummary; siteRevision: number }>;
  revoke(appSlug: string, id: string, value: { baseRevision: number; invitationRevision: number }, signal: AbortSignal): Promise<{ invitation: EmailInvitationSummary; siteRevision: number }>;
}

export class EmailInvitationError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 503) { super("Invitation request failed"); }
}

export const EMAIL_INVITES_PER_REQUEST = 100;
const MAX_PREVIEW_APPS = 32;
const MAX_PREVIEW_INVITES = 200;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PreviewApp { active: boolean; revision: number; invitations: EmailInvitationSummary[] }

function abortIfNeeded(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

/**
 * In-memory stand-in for the 2691 API. State lives only in this tab, is
 * bounded (LRU over apps, capped invitations) and sends no email.
 */
export function createInMemoryEmailInvitations(options: { now?: () => number; newId?: () => string } = {}): EmailInvitationAdapter {
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const apps = new Map<string, PreviewApp>();
  const entry = (appSlug: string): PreviewApp => {
    const existing = apps.get(appSlug);
    if (existing) { apps.delete(appSlug); apps.set(appSlug, existing); return existing; }
    if (apps.size >= MAX_PREVIEW_APPS) { const oldest = apps.keys().next().value; if (oldest !== undefined) apps.delete(oldest); }
    const created: PreviewApp = { active: false, revision: 0, invitations: [] };
    apps.set(appSlug, created);
    return created;
  };
  const visible = (app: PreviewApp) => app.invitations.filter((invitation) => invitation.state !== "revoked");
  const requireRevision = (app: PreviewApp, baseRevision: number) => {
    if (baseRevision !== app.revision) throw new EmailInvitationError(409);
  };
  return {
    kind: "preview",
    active: (appSlug) => apps.get(appSlug)?.active ?? false,
    async activate(appSlug, signal) {
      abortIfNeeded(signal);
      const app = entry(appSlug);
      if (!app.active) { app.active = true; app.revision += 1; }
    },
    async deactivate(appSlug, signal) {
      abortIfNeeded(signal);
      const app = entry(appSlug);
      // 2691: leaving private_email revokes pending invites and accepted grants permanently.
      app.active = false; app.invitations = []; app.revision += 1;
    },
    async list(appSlug, signal) {
      abortIfNeeded(signal);
      const app = entry(appSlug);
      return { invitations: visible(app), siteRevision: app.revision };
    },
    async invite(appSlug, value, signal) {
      abortIfNeeded(signal);
      const app = entry(appSlug);
      if (!app.active) throw new EmailInvitationError(404);
      if (value.emailAddresses.length === 0 || value.emailAddresses.length > EMAIL_INVITES_PER_REQUEST) throw new EmailInvitationError(400);
      requireRevision(app, value.baseRevision);
      const seen = new Set<string>();
      const results: EmailInvitationResult[] = value.emailAddresses.map((raw, inputIndex) => {
        const emailAddress = raw.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress) || emailAddress.length > 254) return { inputIndex, outcome: "invalid" };
        if (seen.has(emailAddress)) return { inputIndex, outcome: "duplicate_in_batch" };
        seen.add(emailAddress);
        const existing = visible(app).find((invitation) => invitation.emailAddress === emailAddress);
        if (existing) return { inputIndex, outcome: "existing", invitation: existing };
        if (visible(app).length >= MAX_PREVIEW_INVITES) return { inputIndex, outcome: "policy_rejected" };
        const issuedAt = now();
        const invitation: EmailInvitationSummary = {
          id: newId(), emailAddress, state: "pending", revision: 1,
          issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(issuedAt + INVITATION_TTL_MS).toISOString(),
        };
        app.invitations = [...app.invitations, invitation];
        return { inputIndex, outcome: "queued", invitation };
      });
      if (results.some((result) => result.outcome === "queued")) app.revision += 1;
      return { results, siteRevision: app.revision };
    },
    async resend(appSlug, id, value, signal) {
      abortIfNeeded(signal);
      const app = entry(appSlug);
      requireRevision(app, value.baseRevision);
      const current = visible(app).find((invitation) => invitation.id === id);
      if (!current) throw new EmailInvitationError(404);
      if (current.revision !== value.invitationRevision) throw new EmailInvitationError(409);
      const issuedAt = now();
      const invitation = { ...current, state: "pending" as const, revision: current.revision + 1, issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(issuedAt + INVITATION_TTL_MS).toISOString() };
      app.invitations = app.invitations.map((item) => item.id === id ? invitation : item);
      app.revision += 1;
      return { invitation, siteRevision: app.revision };
    },
    async revoke(appSlug, id, value, signal) {
      abortIfNeeded(signal);
      const app = entry(appSlug);
      requireRevision(app, value.baseRevision);
      const current = visible(app).find((invitation) => invitation.id === id);
      if (!current) throw new EmailInvitationError(404);
      if (current.revision !== value.invitationRevision) throw new EmailInvitationError(409);
      const invitation = { ...current, state: "revoked" as const, revision: current.revision + 1 };
      app.invitations = app.invitations.map((item) => item.id === id ? invitation : item);
      app.revision += 1;
      return { invitation, siteRevision: app.revision };
    },
  };
}

/** Build-time preview flag. Off by default, so production shows invites as unavailable. */
export function emailInvitesPreviewEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

const sharedPreview = { adapter: null as EmailInvitationAdapter | null };
/** One fake per renderer process so the popover keeps state while it reopens. */
export function previewEmailInvitationAdapter(enabled: boolean): EmailInvitationAdapter | null {
  if (!enabled) return null;
  sharedPreview.adapter ??= createInMemoryEmailInvitations();
  return sharedPreview.adapter;
}
