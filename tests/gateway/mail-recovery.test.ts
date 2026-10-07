import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mailTestDatabase } from './mail-test-database.js';
import { MailArchiveRepository } from '../../packages/gateway/src/mail/repository.js';
import { createMailService } from '../../packages/gateway/src/mail/service.js';
import { NEWSLETTER_POLICY_VERSION } from '../../packages/gateway/src/mail/policy.js';
import type { StoredCleanupPlan } from '../../packages/gateway/src/mail/types.js';
describe('durable cleanup recovery', () => {
    let repository: MailArchiveRepository;
    let close: () => Promise<void>;
    let clock: Date;
    const key = { ownerId: 'owner', accountId: 'account' };
    beforeEach(async () => {
        clock = new Date('2026-10-07T12:00:00Z');
        const fixture = await mailTestDatabase();
        close = fixture.cleanup;
        repository = new MailArchiveRepository(fixture.dialect, { now: () => clock });
        await repository.bootstrap();
        await repository.registerSource({ ...key, connectionId: 'conn', provider: 'gmail', email: 'a@example.com', accountLabel: 'Personal', group: 'personal' });
        await repository.grantConsumer({ ...key, appId: 'edition' });
    });
    afterEach(async () => {
        await repository.destroy();
        await close();
    });
    async function operation(id: string, state: 'unknown' | 'confirmed' | 'undo_pending' | 'dispatching' = 'unknown') {
        const source = (await repository.getSource(key))!;
        const saved = await repository.saveMessage({ ...key, messageId: `provider-${id}`, threadId: 'thread', subject: 'Letter', sender: 'Publisher', receivedAt: '2026-10-01T00:00:00Z', labels: ['INBOX'], object: { namespace: source.namespace, digest: 'a'.repeat(64), sizeBytes: 10 } });
        if (saved.kind !== 'saved')
            throw Error('save');
        const binding = createHash('sha256').update(JSON.stringify({ service: 'gmail', connectionId: 'conn', accountLabel: 'Personal', expectedEmail: 'a@example.com' })).digest('hex');
        const messages = [{ messageId: saved.message.messageId, contentDigest: 'a'.repeat(64), ready: true, category: 'newsletter', revision: saved.message.revision, policyVersion: NEWSLETTER_POLICY_VERSION }];
        const hash = createHash('sha256').update(JSON.stringify([binding, NEWSLETTER_POLICY_VERSION, messages.map(m => [m.messageId, m.contentDigest, m.ready, m.category, m.revision, m.policyVersion])])).digest('hex');
        const plan: StoredCleanupPlan = { ...key, id, binding, hash, expiresAt: clock.getTime() + 600000, policyVersion: NEWSLETTER_POLICY_VERSION, messages };
        await repository.savePlan(plan);
        const op = await repository.claimOperation(plan);
        await repository.transition({ ...key, operationId: op.id, messageId: saved.message.messageId, from: 'planned', next: { messageId: saved.message.messageId, state: 'dispatching', originalInbox: true, labels: ['INBOX'] } });
        if (state !== 'dispatching')
            await repository.transition({ ...key, operationId: op.id, messageId: saved.message.messageId, from: 'dispatching', next: { messageId: saved.message.messageId, state: state === 'undo_pending' ? 'confirmed' : state, originalInbox: true, labels: ['UNREAD'] } });
        if (state === 'undo_pending')
            await repository.transition({ ...key, operationId: op.id, messageId: saved.message.messageId, from: 'confirmed', next: { messageId: saved.message.messageId, state, originalInbox: true, labels: ['UNREAD'] } });
        return { plan, op, message: saved.message };
    }
    it('recovers expired submitted plans with opaque IDs and exact owner scope', async () => {
        const { plan, op, message } = await operation('plan');
        clock = new Date(clock.getTime() + 600001);
        const recovered = await repository.listRecoverableCleanupOperations({ ownerId: 'owner', appId: 'edition', limit: 20 });
        expect(recovered).toHaveLength(1);
        expect(recovered[0].operation.id).toBe(op.id);
        expect(recovered[0].operation.plan.id).toBe(plan.id);
        expect(recovered[0].messageIds).toEqual([message.id]);
        expect(await repository.listRecoverableCleanupOperations({ ownerId: 'other', appId: 'edition' })).toEqual([]);
        await expect(repository.listRecoverableCleanupOperations({ ownerId: 'owner', appId: 'folio' })).rejects.toThrow();
    });
    it('requires current grants and hides deleted or out-of-range content', async () => {
        const { message } = await operation('plan');
        await repository.revokeConsumer({ ...key, appId: 'edition' });
        expect(await repository.listRecoverableCleanupOperations({ ownerId: 'owner', appId: 'edition' })).toEqual([]);
        await repository.grantConsumer({ ...key, appId: 'edition', from: '2026-10-02T00:00:00Z' });
        expect(await repository.listRecoverableCleanupOperations({ ownerId: 'owner', appId: 'edition' })).toEqual([]);
        await repository.grantConsumer({ ...key, appId: 'edition' });
        await repository.suppressMessage({ ...key, messageId: message.messageId });
        expect(await repository.listRecoverableCleanupOperations({ ownerId: 'owner', appId: 'edition' })).toEqual([]);
    });
    it('includes confirmed undoable receipts but removes completed restorations', async () => {
        const { message, op } = await operation('plan', 'confirmed');
        expect(await repository.listRecoverableCleanupOperations({ ownerId: 'owner', appId: 'edition' })).toHaveLength(1);
        await repository.transition({ ...key, operationId: op.id, messageId: message.messageId, from: 'confirmed', next: { messageId: message.messageId, state: 'undone', originalInbox: true } });
        expect(await repository.listRecoverableCleanupOperations({ ownerId: 'owner', appId: 'edition' })).toEqual([]);
    });
    it('caps recovered operations and never exposes provider IDs in the app response', async () => {
        await operation('plan', 'undo_pending');
        await operation('plan2', 'dispatching');
        expect(await repository.listRecoverableCleanupOperations({ ownerId: 'owner', appId: 'edition', limit: 1 })).toHaveLength(1);
        const call = vi.fn();
        const service = createMailService({ repository, objects: { read: vi.fn() }, transport: { inventory: vi.fn(), call } as never, ownerId: 'owner', sync: vi.fn(), notify: vi.fn() });
        const response = await service.handle('owner', { appId: 'edition', action: 'cleanup-recovery', payload: {} } as never, AbortSignal.timeout(1000)) as any;
        expect(response.operations).toHaveLength(2);
        expect(response.operations[0].plan).toMatchObject({ revision: 0, messageIds: [expect.any(String)] });
        expect(response.operations[0].receipt).toMatchObject({ state: 'needs_verification' });
        expect(JSON.stringify(response)).not.toContain('provider-');
        expect(call).not.toHaveBeenCalled();
        await expect(service.handle('owner', { appId: 'folio', action: 'cleanup-recovery', payload: {} } as never, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 403 });
    });
});
it('rejects invalid recovery limits before database work', async () => {
    const db = await mailTestDatabase();
    const repository = new MailArchiveRepository(db.dialect);
    try {
        await expect(repository.listRecoverableCleanupOperations({ ownerId: 'owner', appId: 'edition', limit: 0 })).rejects.toThrow();
        await expect(repository.listRecoverableCleanupOperations({ ownerId: 'owner', appId: 'edition', limit: NaN })).rejects.toThrow();
    }
    finally {
        await repository.destroy();
        await db.cleanup();
    }
});
