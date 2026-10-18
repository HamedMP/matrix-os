import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { PostgresComputeAdmissionStore, type AdmissionData } from '../../packages/workspace-worker/src/data/compute-admission.js';
import type { WorkspaceAction } from '../../packages/workspace-worker/src/routes.js';

// Invalid external boundaries must fail before any database operation is possible.
const store = new PostgresComputeAdmissionStore({} as Kysely<AdmissionData>, async () => { throw new Error('Unexpected Chat admission'); });
const chat: WorkspaceAction = { type: 'chat', chatId: 'chat_one', message: 'hello', idempotencyKey: 'request_1' };
describe('compute admission boundary validation', () => {
  it.each([
    ['invalid/owner', chat, 100, 100],
    ['', chat, 100, 100],
    ['owner', { ...chat, message: ' ' }, 100, 100],
    ['owner', { ...chat, chatId: 'invalid' }, 100, 100],
    ['owner', { ...chat, idempotencyKey: 'invalid/request' }, 100, 100],
    ['owner', { ...chat, tier: 'free' }, 100, 100],
    ['owner', { type: 'wake', allowanceMs: 100000 }, 100, 100],
    ['owner', chat, 0, 100],
    ['owner', chat, 1800001, 100],
    ['owner', chat, 100, -1],
  ])('rejects malformed authority and task inputs before persistence (%s)', async (owner, action, amount, now) => {
    await expect(store.admit(owner as string, action as WorkspaceAction, amount as number, now as number)).rejects.toMatchObject({ code: 'invalid' });
  });
  it('bounds dispatcher/reconciler batches before accessing persistence', async () => {
    await expect(store.dispatch(async () => undefined, 100, 101)).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.reconcileOwners(100, 0)).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.configureAccount({ ownerId: 'owner', periodId: 'period', state: 'unknown' as 'active' }, 100)).rejects.toMatchObject({ code: 'invalid' });
  });
});
