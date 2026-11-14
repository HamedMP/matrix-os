import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAccountDeletionRoutes } from '../../packages/platform/src/account-deletion/routes.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine } from '../../packages/platform/src/db.js';
import { acceptSiteEmailInvitation } from '../../packages/platform/src/sites/email-invitations.js';
import { authorizeEmailViewerSession } from '../../packages/platform/src/sites/email-viewer-sessions.js';
import { recordSiteRecipientLifecycle } from '../../packages/platform/src/sites/account-lifecycle.js';

const signingKey = Buffer.from('site-recipient-webhook-signing-key-1234567890');
const signingSecret = `whsec_${signingKey.toString('base64')}`;

function signedEvent(id: string, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', signingKey).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
}

describe('signed Clerk recipient lifecycle webhook', () => {
  it('denies an already issued viewer cookie after a signed deprovisioned update', async () => {
    const { db } = await createTestPlatformDb();
    const secret = 'site-recipient-webhook-test-secret-123456';
    const siteId = randomUUID(), invitationId = randomUUID(), now = new Date();
    try {
      await insertUserMachine(db, { machineId: 'recipient-webhook-owner-machine', clerkUserId: 'user_owner',
        handle: 'recipient-webhook-owner', status: 'running', provisionedAt: now.toISOString() });
      await db.executor.insertInto('public_sites').values({ id: siteId, owner_id: 'user_owner',
        machine_id: 'recipient-webhook-owner-machine', app_slug: 'event', title: 'Event', description: '',
        slug: null, revision: 1, status: 'published', access_mode: 'private_email', active_version: null,
        created_at: now.toISOString() }).execute();
      await db.executor.insertInto('public_site_email_invitations').values({ id: invitationId, site_id: siteId,
        normalized_email: 'guest@example.com', display_email: 'guest@example.com', generation: '1',
        state: 'pending', delivery_state: 'sent', invited_by_clerk_user_id: 'user_owner',
        accepted_clerk_user_id: null, created_at: now, issued_at: now,
        expires_at: new Date(now.getTime() + 86400_000), accepted_at: null, revoked_at: null,
        state_reason: null, updated_at: now, revision: '0' }).execute();
      const issued = await acceptSiteEmailInvitation({ db, siteId,
        identity: { clerkUserId: 'user_recipient', clerkSessionId: 'sess_browser', verifiedEmails: ['guest@example.com'] }, secret });
      expect(await authorizeEmailViewerSession(db, siteId, issued.cookie, secret)).toBe(true);
      const routes = createAccountDeletionRoutes({ service: { schedule: vi.fn() } as never,
        verify: async () => null, webhookSecret: signingSecret, newRequestsEnabled: true,
        recordRecipientLifecycle: event => recordSiteRecipientLifecycle(db, { ...event, secret }) });
      const body = JSON.stringify({ type: 'user.updated', data: { id: 'user_recipient',
        banned: false, locked: false, deprovisioned: true } });
      expect((await routes.request('/webhooks/clerk/users', { method: 'POST',
        headers: signedEvent('evt_deprovisioned_cookie', body), body })).status).toBe(200);
      expect(await authorizeEmailViewerSession(db, siteId, issued.cookie, secret)).toBe(false);
    } finally { await destroyTestPlatformDb(db); }
  });
  it('delegates manual deletion and cancellation to the service transaction', async () => {
    const recordRecipientLifecycle = vi.fn(async () => undefined);
    const service = { schedule: vi.fn(async () => ({ status: 'scheduled' })),
      cancel: vi.fn(async () => ({ status: 'cancelled' })) };
    const routes = createAccountDeletionRoutes({
      service: service as never,
      verify: async token => token === 'verified' ? 'user_recipient' : null,
      newRequestsEnabled: true, recordRecipientLifecycle,
    });
    const headers = { authorization: 'Bearer verified', 'content-type': 'application/json' };
    const body = JSON.stringify({ confirm: true });
    expect((await routes.request('/api/account/delete', { method: 'POST', headers, body })).status).toBe(202);
    expect(service.schedule).toHaveBeenCalledWith('user_recipient');
    expect((await routes.request('/api/account/delete/cancel', { method: 'POST', headers, body })).status).toBe(200);
    expect(service.cancel).toHaveBeenCalledWith('user_recipient');
    expect(recordRecipientLifecycle).not.toHaveBeenCalled();
  });
  it('projects inactive and deleted users and rejects unsigned updates', async () => {
    const schedule = vi.fn(async () => ({ status: 'scheduled' }));
    const recordRecipientLifecycle = vi.fn(async () => undefined);
    const routes = createAccountDeletionRoutes({
      service: { schedule } as never, verify: async () => null, webhookSecret: signingSecret,
      newRequestsEnabled: true, recordRecipientLifecycle,
    });
    const occurredAt = Date.now() - 1000;
    const inactive = JSON.stringify({ type: 'user.updated', timestamp: occurredAt,
      data: { id: 'user_recipient', banned: true } });
    expect((await routes.request('/webhooks/clerk/users', { method: 'POST', body: inactive })).status).toBe(401);
    expect(recordRecipientLifecycle).not.toHaveBeenCalled();
    expect((await routes.request('/webhooks/clerk/users', { method: 'POST',
      headers: signedEvent('evt_inactive', inactive), body: inactive })).status).toBe(200);
    expect(recordRecipientLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_recipient', state: 'inactive', eventId: 'evt_inactive', eventAt: new Date(occurredAt),
    }));
    const deprovisioned = JSON.stringify({ type: 'user.updated', timestamp: occurredAt + 1,
      data: { id: 'user_recipient', banned: false, locked: false, deprovisioned: true } });
    expect((await routes.request('/webhooks/clerk/users', { method: 'POST',
      headers: signedEvent('evt_deprovisioned', deprovisioned), body: deprovisioned })).status).toBe(200);
    expect(recordRecipientLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_recipient', state: 'inactive', eventId: 'evt_deprovisioned',
    }));
    const deleted = JSON.stringify({ type: 'user.deleted', data: { id: 'user_recipient', deleted: true } });
    expect((await routes.request('/webhooks/clerk/users', { method: 'POST',
      headers: signedEvent('evt_deleted', deleted), body: deleted })).status).toBe(200);
    expect(recordRecipientLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_recipient', state: 'deleted', eventId: 'evt_deleted',
    }));
    expect(schedule).toHaveBeenCalledWith('user_recipient', true);
  });

  it('returns a retryable failure when the recipient projection cannot commit', async () => {
    const schedule = vi.fn(async () => ({ status: 'scheduled' }));
    const routes = createAccountDeletionRoutes({ service: { schedule } as never,
      verify: async () => null, webhookSecret: signingSecret, newRequestsEnabled: true,
      recordRecipientLifecycle: async () => { throw new Error('database unavailable'); } });
    const body = JSON.stringify({ type: 'user.deleted', data: { id: 'user_recipient', deleted: true } });
    const response = await routes.request('/webhooks/clerk/users', { method: 'POST',
      headers: signedEvent('evt_failure', body), body });
    expect(response.status).toBe(503);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('uses signed Clerk session end and revoke events as a cross-site revocation backup', async () => {
    const recordSessionTermination = vi.fn(async () => undefined);
    const routes = createAccountDeletionRoutes({ service: { schedule: vi.fn() } as never,
      verify: async () => null, webhookSecret: signingSecret, newRequestsEnabled: true,
      recordSessionTermination });
    for (const type of ['session.ended', 'session.revoked']) {
      const body = JSON.stringify({ type, data: { id: 'sess_backup_123', user_id: 'user_recipient' } });
      const response = await routes.request('/webhooks/clerk/users', { method: 'POST',
        headers: signedEvent(`evt_${type.replace('.', '_')}`, body), body });
      expect(response.status).toBe(200);
    }
    expect(recordSessionTermination).toHaveBeenCalledTimes(2);
    expect(recordSessionTermination).toHaveBeenCalledWith('sess_backup_123');
  });
});
