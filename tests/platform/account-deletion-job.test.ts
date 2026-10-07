import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from './platform-db-test-helper.js';
import { createAccountDeletionService } from '../../packages/platform/src/account-deletion/service.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { ACCOUNT_DELETION_GRACE_MS, type AccountDeletionAdapters } from '../../packages/platform/src/account-deletion/types.js';

const secret = 'account-deletion-test-secret-at-least-32-bytes';
const owner = 'user_deletion000000000000001';
const token = 'private-apple-refresh-token';
function makeAdapters(): AccountDeletionAdapters {
  return {
    prepare: vi.fn(async (clerkUserId: string) => ({ clerkUserId, appleTokens: [{ clientId: 'com.matrixos.mobile', token, tokenType: 'refresh_token' as const }] })),
    billing: vi.fn(async () => {}), vps: vi.fn(async () => {}), integrations: vi.fn(async () => {}),
    apple: vi.fn(async () => {}), storage: vi.fn(async () => {}), data: vi.fn(async () => {}), clerk: vi.fn(async () => {}),
  };
}
describe('durable account deletion job', () => {
  let fixture: TestPlatformDb;
  let clock: Date;
  let adapters: AccountDeletionAdapters;
  const now = () => clock;
  const service = () => createAccountDeletionService({ db: fixture.db.kysely, adapters, secret, now, logError: vi.fn() });
  beforeEach(async () => { fixture = await createTestPlatformDb(); clock = new Date('2026-10-05T12:00:00.000Z'); adapters = makeAdapters(); });
  afterEach(async () => { await destroyTestPlatformDb(fixture?.db); });

  it('preflights ownership, persists encrypted credentials and stops billing immediately with five days to export', async () => {
    const status = await service().schedule(owner);
    expect(status).toEqual({ status: 'scheduled', erasesAfter: new Date(clock.getTime() + ACCOUNT_DELETION_GRACE_MS).toISOString(), completesBy: new Date(clock.getTime() + ACCOUNT_DELETION_GRACE_MS + 86400000).toISOString(), billingStopped: true });
    expect(adapters.prepare).toHaveBeenCalledWith(owner, false, expect.anything());
    expect(adapters.billing).toHaveBeenCalledOnce();
    expect(adapters.vps).not.toHaveBeenCalled();
    const [row] = await fixture.db.kysely.selectFrom('account_deletion_jobs').selectAll().execute();
    expect(JSON.stringify(row)).not.toContain(owner);
    expect(JSON.stringify(row)).not.toContain(token);
    const repo = new AccountDeletionRepository(fixture.db.kysely, { secret, now });
    expect(repo.decrypt(row).clerkUserId).toBe(owner);
    expect(() => repo.decrypt({ ...row, owner_hash: 'another-owner-hash' })).toThrow();
    expect(() => new AccountDeletionRepository(fixture.db.kysely, { secret: 'short' })).toThrow('not configured');
    expect(await service().isBlocked(owner)).toBe(true);
  });
  it('does not accept deletion when ownership or Apple credential preflight fails', async () => {
    vi.mocked(adapters.prepare).mockRejectedValue(new Error('transfer ownership'));
    await expect(service().schedule(owner)).rejects.toThrow();
    expect(await service().get(owner)).toMatchObject({ status: 'none' });
    expect(adapters.billing).not.toHaveBeenCalled();
  });
  it('repeated requests do not reset grace or duplicate billing and cancellation is durable', async () => {
    const first = await service().schedule(owner);
    clock = new Date(clock.getTime() + 1000);
    expect(await service().schedule(owner)).toEqual(first);
    expect(adapters.billing).toHaveBeenCalledOnce();
    expect(await service().cancel(owner)).toMatchObject({ status: 'cancelled', billingStopped: true });
    expect(await service().isBlocked(owner)).toBe(false);
    clock = new Date(clock.getTime() + ACCOUNT_DELETION_GRACE_MS);
    await service().reconcile();
    expect(adapters.vps).not.toHaveBeenCalled();
    expect(await service().schedule(owner)).toMatchObject({ status: 'scheduled' });
  });
  it('resumes at a failed checkpoint after recreation and purges PII only once all steps complete', async () => {
    await service().schedule(owner);
    clock = new Date(clock.getTime() + ACCOUNT_DELETION_GRACE_MS);
    vi.mocked(adapters.storage).mockRejectedValueOnce(new Error('provider failed'));
    await service().reconcile();
    expect(await service().get(owner)).toMatchObject({ status: 'processing' });
    expect(adapters.clerk).not.toHaveBeenCalled();
    expect(adapters.apple).toHaveBeenCalledOnce();
    clock = new Date(clock.getTime() + 60_000);
    await service().reconcile();
    expect(adapters.vps).toHaveBeenCalledOnce();
    expect(adapters.storage).toHaveBeenCalledTimes(2);
    expect(adapters.clerk).toHaveBeenCalledOnce();
    expect(await service().get(owner)).toMatchObject({ status: 'completed', billingStopped: true });
    const [row] = await fixture.db.kysely.selectFrom('account_deletion_jobs').selectAll().execute();
    expect(row.encrypted_context).toBeNull();
    expect(row.last_error_code).toBeNull();
  });
  it('retains cached Apple credentials when identity-deleted webhook accelerates grace', async () => {
    await service().schedule(owner);
    vi.mocked(adapters.prepare).mockRejectedValue(new Error('Clerk user already absent'));
    await service().schedule(owner, true);
    await service().reconcile();
    expect(adapters.apple).toHaveBeenCalledWith(expect.objectContaining({ appleTokens: [expect.objectContaining({ token })] }));
    expect(await service().get(owner)).toMatchObject({ status: 'completed' });
  });
  it('retries immediate billing failures before destroying any runtime', async () => {
    vi.mocked(adapters.billing).mockRejectedValueOnce(new Error('Stripe offline'));
    expect(await service().schedule(owner)).toMatchObject({ status: 'scheduled', billingStopped: false });
    clock = new Date(clock.getTime() + 60_000);
    await service().reconcile();
    expect(adapters.billing).toHaveBeenCalledTimes(2);
    expect(adapters.vps).not.toHaveBeenCalled();
  });
  it('resets billing confirmation on reschedule and retains retry after cancellation conflicts', async () => {
    await service().schedule(owner);
    await service().cancel(owner);
    clock = new Date(clock.getTime() + 86_400_000);
    vi.mocked(adapters.billing).mockRejectedValueOnce(new Error('Stripe offline after reschedule'));
    expect(await service().schedule(owner)).toMatchObject({ status: 'scheduled', billingStopped: false });
    await expect(service().cancel(owner)).rejects.toThrow('can no longer be cancelled');
    const repo = new AccountDeletionRepository(fixture.db.kysely, { secret, now });
    expect((await repo.get(owner))?.encrypted_context).not.toBeNull();
    clock = new Date(clock.getTime() + 60_000);
    await service().reconcile();
    expect(adapters.billing).toHaveBeenCalledTimes(3);
    expect(await service().get(owner)).toMatchObject({ status: 'scheduled', billingStopped: true });
    expect(adapters.vps).not.toHaveBeenCalled();
    expect(await service().cancel(owner)).toMatchObject({ status: 'cancelled', billingStopped: true });
  });
  it('persists refreshed Apple revocation credentials before revoke and replays them after a lost checkpoint', async () => {
    const refreshedToken = 'refreshed-apple-grant-token';
    adapters.prepareAppleRevocation = vi.fn(async (context) => ({ ...context, appleRevocationPrepared: true,
      appleTokens: [{ clientId: 'com.matrixos.mobile', token: refreshedToken, tokenType: 'refresh_token' as const }] }));
    const repo = new AccountDeletionRepository(fixture.db.kysely, { secret, now });
    const singlePass = () => createAccountDeletionService({ db: fixture.db.kysely, adapters, secret, now, batchSize: 1, logError: vi.fn() });
    let savedBeforeRevoke = false;
    vi.mocked(adapters.apple).mockImplementationOnce(async (context) => {
      savedBeforeRevoke = repo.decrypt((await repo.get(owner))!).appleRevocationPrepared === true
        && context.appleTokens[0]?.token === refreshedToken;
      clock = new Date(clock.getTime() + 120_001); // Remote revocation succeeded, then the worker lost its lease before checkpointing.
    });
    await singlePass().schedule(owner);
    clock = new Date(clock.getTime() + ACCOUNT_DELETION_GRACE_MS);
    await singlePass().reconcile();
    expect(savedBeforeRevoke).toBe(true);
    expect(adapters.prepareAppleRevocation).toHaveBeenCalledOnce();
    expect((await repo.get(owner))?.next_step).toBe(3);
    expect(repo.decrypt((await repo.get(owner))!).appleTokens[0]?.token).toBe(refreshedToken);
    vi.mocked(adapters.prepareAppleRevocation).mockRejectedValue(new Error('Clerk grant already revoked'));
    await singlePass().reconcile();
    expect(adapters.prepareAppleRevocation).toHaveBeenCalledOnce();
    expect(adapters.apple).toHaveBeenCalledTimes(2);
    expect(vi.mocked(adapters.apple).mock.calls[1][0].appleTokens[0]?.token).toBe(refreshedToken);
    expect(await singlePass().get(owner)).toMatchObject({ status: 'completed' });
  });
  it('rejects a refreshed Apple context for a different owner', async () => {
    adapters.prepareAppleRevocation = vi.fn(async (context) => ({ ...context,
      clerkUserId: 'user_anotherowner000000000001', appleRevocationPrepared: true }));
    const singlePass = createAccountDeletionService({ db: fixture.db.kysely, adapters, secret, now, batchSize: 1, logError: vi.fn() });
    await singlePass.schedule(owner);
    clock = new Date(clock.getTime() + ACCOUNT_DELETION_GRACE_MS);
    await singlePass.reconcile();
    expect(adapters.apple).not.toHaveBeenCalled();
    const repo = new AccountDeletionRepository(fixture.db.kysely, { secret, now });
    expect(repo.decrypt((await repo.get(owner))!).clerkUserId).toBe(owner);
    expect((await repo.get(owner))?.last_error_code).toBe('cleanup_retry');
  });
  it('does not revoke Apple credentials when preparation loses its lease', async () => {
    adapters.prepareAppleRevocation = vi.fn(async (context) => {
      clock = new Date(clock.getTime() + 120_001);
      return { ...context, appleRevocationPrepared: true };
    });
    const singlePass = createAccountDeletionService({ db: fixture.db.kysely, adapters, secret, now, batchSize: 1, logError: vi.fn() });
    await singlePass.schedule(owner);
    clock = new Date(clock.getTime() + ACCOUNT_DELETION_GRACE_MS);
    await singlePass.reconcile();
    expect(adapters.apple).not.toHaveBeenCalled();
    const repo = new AccountDeletionRepository(fixture.db.kysely, { secret, now });
    expect(repo.decrypt((await repo.get(owner))!).appleRevocationPrepared).not.toBe(true);
  });
  it('preserves unknown Apple revocation state through encrypted persistence', async () => {
    const repo = new AccountDeletionRepository(fixture.db.kysely, { secret, now });
    const job = await repo.accept({ clerkUserId: owner, appleTokens: [], appleRevocationUnknown: true }, true);
    expect(repo.decrypt(job).appleRevocationUnknown).toBe(true);
  });
  it('keeps aggregate accounting evidence after purging identifying context', async () => {
    await service().schedule(owner);
    const repo = new AccountDeletionRepository(fixture.db.kysely, { secret, now });
    const summary = { settledMicrousd: 12345, absorbedOverrunMicrousd: 5, reservationCount: 2 };
    await fixture.db.kysely.updateTable('account_deletion_jobs').set({ accounting_summary: summary })
      .where('owner_hash', '=', repo.ownerHash(owner)).execute();
    clock = new Date(clock.getTime() + ACCOUNT_DELETION_GRACE_MS);
    await service().reconcile();
    const row = await repo.get(owner);
    expect(row?.status).toBe('completed');
    expect(row?.encrypted_context).toBeNull();
    expect(row?.accounting_summary).toEqual(summary);
    expect(JSON.stringify(row)).not.toContain(owner);
    expect(JSON.stringify(row)).not.toContain(token);
  });
  it('refreshes grace eligibility time when a cancelled owner schedules again', async () => {
    await service().schedule(owner);
    await service().cancel(owner);
    clock = new Date(clock.getTime() + 86_400_000);
    await service().schedule(owner);
    const repo = new AccountDeletionRepository(fixture.db.kysely, { secret, now });
    expect((await repo.get(owner))?.created_at).toBe(clock.toISOString());
  });
  it('fences expired leases and refuses cancellation after a destructive claim', async () => {
    await service().schedule(owner);
    clock = new Date(clock.getTime() + ACCOUNT_DELETION_GRACE_MS);
    const repo = new AccountDeletionRepository(fixture.db.kysely, { secret, now });
    const claimed = await repo.claim(undefined, 1000);
    expect(claimed?.status).toBe('processing');
    await expect(service().cancel(owner)).rejects.toThrow();
    clock = new Date(clock.getTime() + 1001);
    const reclaimed = await repo.claim(undefined, 1000);
    expect(reclaimed?.lease_token).not.toBe(claimed?.lease_token);
    expect(await repo.checkpoint(claimed!, 2, 1000)).toBe(false);
    expect(await repo.checkpoint(reclaimed!, 2, 1000)).toBe(true);
  });
});
