import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { mailTestDatabase } from './mail-test-database.js';
import { MailArchiveRepository } from '../../packages/gateway/src/mail/repository.js';
describe('durable bounded sync error state', () => {
    let repository: MailArchiveRepository;
    let close: () => Promise<void>;
    let now: Date;
    const key = { ownerId: 'owner', accountId: 'account' };
    beforeEach(async () => {
        now = new Date('2026-10-07T12:00:00Z');
        const fixture = await mailTestDatabase();
        close = fixture.cleanup;
        repository = new MailArchiveRepository(fixture.dialect, { now: () => now });
        await repository.bootstrap();
        await repository.registerSource({ ...key, provider: 'gmail', connectionId: 'conn', email: 'a@example.com', group: 'personal' });
        await repository.enqueueSync({ ...key, rangeFrom: '2026-07-01T00:00:00Z', rangeUntil: now.toISOString() });
    });
    afterEach(async () => {
        await repository.destroy();
        await close();
    });
    const checkpoint = { revision: 0, phase: 'backfill', from: Date.parse('2026-07-01T00:00:00Z'), until: Date.parse('2026-10-07T12:00:00Z') };
    it('atomically records a generic failure and releases the exact lease without retaining raw errors', async () => {
        const job = (await repository.claimSync({ ...key, workerId: 'worker', leaseMs: 60000 }))!;
        expect(await repository.recordSyncFailure({ ...key, token: job.token, baseRevision: 0, checkpoint: { ...checkpoint, lastError: 'secret provider failure', unexpected: 'token' }, failureAt: now.toISOString() })).toBe(true);
        const recovered = (await repository.getSyncJob(key))!;
        expect(recovered.status).toBe('pending');
        expect(recovered.token).toBeNull();
        expect(recovered.checkpoint).toEqual({ ...checkpoint, revision: 1, lastError: 'sync_unavailable', failureAt: now.toISOString() });
        expect(JSON.stringify(recovered)).not.toContain('secret');
        const retry = (await repository.claimSync({ ...key, workerId: 'other' }))!;
        expect(retry.checkpoint).toMatchObject({ revision: 1, lastError: 'sync_unavailable' });
    });
    it('fences other owners, wrong tokens, stale revisions and nonlive leases', async () => {
        const job = (await repository.claimSync({ ...key, workerId: 'worker', leaseMs: 1000 }))!;
        const input = { ...key, token: job.token, baseRevision: 0, checkpoint, failureAt: now.toISOString() };
        expect(await repository.recordSyncFailure({ ...input, ownerId: 'other' })).toBe(false);
        expect(await repository.recordSyncFailure({ ...input, token: 'wrong' })).toBe(false);
        expect(await repository.recordSyncFailure({ ...input, baseRevision: 1, checkpoint: { ...checkpoint, revision: 1 } })).toBe(false);
        now = new Date(now.getTime() + 1001);
        expect(await repository.recordSyncFailure({ ...input, failureAt: now.toISOString() })).toBe(false);
        expect((await repository.getSyncJob(key))!.checkpoint).toBeNull();
    });
    it('rejects unbounded/invalid checkpoints and invalid timestamps before mutation', async () => {
        const job = (await repository.claimSync({ ...key, workerId: 'worker' }))!;
        const input = { ...key, token: job.token, baseRevision: 0, checkpoint, failureAt: now.toISOString() };
        await expect(repository.recordSyncFailure({ ...input, checkpoint: { ...checkpoint, pageOffset: 501 } })).rejects.toThrow();
        await expect(repository.recordSyncFailure({ ...input, failureAt: 'invalid' })).rejects.toThrow();
        await expect(repository.recordSyncFailure({ ...input, baseRevision: -1 })).rejects.toThrow();
        await expect(repository.recordSyncFailure({ ...input, baseRevision: NaN })).rejects.toThrow();
        await expect(repository.recordSyncFailure({ ...input, baseRevision: Number.MAX_SAFE_INTEGER })).rejects.toThrow();
        await expect(repository.recordSyncFailure({ ...input, checkpoint: { ...checkpoint, revision: 1 } })).rejects.toThrow();
        expect((await repository.getSyncJob(key))!.status).toBe('running');
    });
});
