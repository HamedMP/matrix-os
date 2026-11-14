import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { appendSiteInvitationAuditEvent, listSiteInvitationAuditEvents } from '../../packages/platform/src/sites/invitation-audit.js';

describe('owner-scoped site invitation audit', () => {
  let db: PlatformDB;
  const siteId = randomUUID();
  beforeAll(async () => {
    db = (await createTestPlatformDb()).db;
    await db.executor.insertInto('public_sites').values({ id: siteId, owner_id: 'user_audit_owner', machine_id: 'audit-machine',
      app_slug: 'audit-app', title: 'Audit app', description: '', slug: null, revision: 0, status: 'published',
      access_mode: 'private_email', active_version: null, created_at: new Date().toISOString() }).execute();
  });
  afterAll(async () => { await destroyTestPlatformDb(db); });

  it('rejects recipient email, arbitrary JSON, and provider details before insertion', async () => {
    for (const details of [{ email: 'recipient@example.com' }, { providerError: 'secret' }, { reason: 'recipient@example.com' }, { generation: 0 }]) {
      await expect(appendSiteInvitationAuditEvent(db, { siteId, type: 'invitation_created', actorKind: 'owner',
        actorReference: 'user_audit_owner', details })).rejects.toThrow();
    }
    expect((await listSiteInvitationAuditEvents(db, 'user_audit_owner', siteId, { limit: 10 })).events).toEqual([]);
  });

  it('rolls back the audit event with its containing authority transaction', async () => {
    await expect(db.transaction(async trx => {
      await appendSiteInvitationAuditEvent(trx, { siteId, type: 'invitation_created', actorKind: 'owner',
        actorReference: 'user_audit_owner', details: { generation: 1 } });
      throw new Error('invitation write rejected');
    })).rejects.toThrow('invitation write rejected');
    expect((await listSiteInvitationAuditEvents(db, 'user_audit_owner', siteId, { limit: 10 })).events).toEqual([]);
  });

  it('pages by stable keyset and never exposes actor reference or recipient identity', async () => {
    for (let index = 0; index < 105; index++) await db.transaction(trx => appendSiteInvitationAuditEvent(trx, {
      siteId, type: 'invitation_created', actorKind: 'owner', actorReference: 'user_audit_owner', details: { generation: index + 1 },
    }));
    const first = await listSiteInvitationAuditEvents(db, 'user_audit_owner', siteId, { limit: 100 });
    expect(first.events).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    expect(JSON.stringify(first)).not.toContain('user_audit_owner');
    expect(JSON.stringify(first)).not.toContain('recipient@example.com');
    const second = await listSiteInvitationAuditEvents(db, 'user_audit_owner', siteId, { limit: 100, cursor: first.nextCursor! });
    expect(second.events).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.events, ...second.events].map(event => event.id)).size).toBe(105);
    expect((await listSiteInvitationAuditEvents(db, 'user_other', siteId, { limit: 10 })).events).toEqual([]);
    await expect(listSiteInvitationAuditEvents(db, 'user_audit_owner', siteId, { limit: 101 })).rejects.toThrow();
  });
});
