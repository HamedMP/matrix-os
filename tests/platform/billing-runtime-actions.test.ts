import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelOutstandingBillingRuntimeActions,
  claimBillingRuntimeAction,
  completeBillingRuntimeAction,
  enqueueBillingRuntimeAction,
  insertUserMachine,
  listBillingRuntimeActions,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { dispatchBillingRuntimeActions } from '../../packages/platform/src/billing-runtime-actions.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

describe('billing runtime actions', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: 'machine_trial',
      clerkUserId: 'user_123',
      handle: 'trial-user',
      runtimeSlot: 'primary',
      provisioningClass: 'customer',
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      status: 'running',
      imageVersion: 'v1',
      provisionedAt: '2026-05-20T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('leases and completes one due suspension without duplicate provider calls', async () => {
    await enqueueBillingRuntimeAction(db, {
      clerkUserId: 'user_123',
      runtimeSlot: 'primary',
      stripeSubscriptionId: 'sub_trial',
      action: 'suspend',
      reason: 'trial_payment_failed',
      executeAfter: '2026-05-31T00:00:00.000Z',
      createdAt: '2026-05-30T00:00:00.000Z',
    });
    const suspendForBilling = vi.fn().mockResolvedValue(undefined);
    const resumeForBilling = vi.fn().mockResolvedValue(undefined);
    const captureEvent = vi.fn();

    const [first, concurrent] = await Promise.all([
      dispatchBillingRuntimeActions({
        db,
        customerVpsService: { suspendForBilling, resumeForBilling },
        now: () => new Date('2026-05-31T00:00:00.000Z'),
        captureEvent,
      }),
      dispatchBillingRuntimeActions({
        db,
        customerVpsService: { suspendForBilling, resumeForBilling },
        now: () => new Date('2026-05-31T00:00:00.000Z'),
        captureEvent,
      }),
    ]);

    expect(first.completed + concurrent.completed).toBe(1);
    expect(suspendForBilling).toHaveBeenCalledOnce();
    expect(resumeForBilling).not.toHaveBeenCalled();
    expect(captureEvent).toHaveBeenCalledWith('matrix_vps_suspended', {
      properties: { reason: 'trial_payment_failed', attempt: 1 },
    });
    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({ status: 'completed', attempts: 1, lastErrorCode: null }),
    ]);
  });

  it('requeues provider failures with a bounded delay and a generic error code', async () => {
    await enqueueBillingRuntimeAction(db, {
      clerkUserId: 'user_123',
      runtimeSlot: 'primary',
      stripeSubscriptionId: 'sub_trial',
      action: 'resume',
      reason: 'payment_recovered',
      executeAfter: '2026-05-31T00:00:00.000Z',
      createdAt: '2026-05-30T00:00:00.000Z',
    });

    await expect(dispatchBillingRuntimeActions({
      db,
      customerVpsService: {
        suspendForBilling: vi.fn(),
        resumeForBilling: vi.fn().mockRejectedValue(new Error('provider token sk_live_secret')),
      },
      now: () => new Date('2026-05-31T00:00:00.000Z'),
    })).resolves.toEqual({ checked: 1, completed: 0, failed: 0, retried: 1 });

    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({
        status: 'queued',
        attempts: 1,
        executeAfter: '2026-05-31T00:01:00.000Z',
        lastErrorCode: 'runtime_action_failed',
      }),
    ]);
    expect(JSON.stringify(await listBillingRuntimeActions(db, 'sub_trial'))).not.toContain('sk_live_secret');
  });

  it('does not let a recovery resume overtake an in-flight suspension', async () => {
    const suspend = await enqueueBillingRuntimeAction(db, {
      clerkUserId: 'user_123', runtimeSlot: 'primary', stripeSubscriptionId: 'sub_trial',
      action: 'suspend', reason: 'trial_payment_failed', executeAfter: '2026-05-31T00:00:00.000Z',
      createdAt: '2026-05-30T00:00:00.000Z',
    });
    expect(suspend).toBeDefined();
    await claimBillingRuntimeAction(
      db, suspend!.id, '2026-05-31T00:00:00.000Z', '2026-05-31T00:05:00.000Z', 5,
    );
    await enqueueBillingRuntimeAction(db, {
      clerkUserId: 'user_123', runtimeSlot: 'primary', stripeSubscriptionId: 'sub_trial',
      action: 'resume', reason: 'payment_recovered', executeAfter: '2026-05-31T00:00:01.000Z',
      createdAt: '2026-05-31T00:00:01.000Z',
    });
    const resumeForBilling = vi.fn().mockResolvedValue(undefined);

    await expect(dispatchBillingRuntimeActions({
      db,
      customerVpsService: { suspendForBilling: vi.fn(), resumeForBilling },
      now: () => new Date('2026-05-31T00:00:01.000Z'),
    })).resolves.toEqual({ checked: 0, completed: 0, failed: 0, retried: 0 });
    expect(resumeForBilling).not.toHaveBeenCalled();

    await completeBillingRuntimeAction(db, suspend!.id, '2026-05-31T00:00:02.000Z');
    await expect(dispatchBillingRuntimeActions({
      db,
      customerVpsService: { suspendForBilling: vi.fn(), resumeForBilling },
      now: () => new Date('2026-05-31T00:00:03.000Z'),
    })).resolves.toMatchObject({ completed: 1 });
    expect(resumeForBilling).toHaveBeenCalledOnce();
  });

  it('does not execute a resume whose lease was revoked by newer billing state', async () => {
    const resume = await enqueueBillingRuntimeAction(db, {
      clerkUserId: 'user_123', runtimeSlot: 'primary', stripeSubscriptionId: 'sub_trial',
      action: 'resume', reason: 'payment_recovered', executeAfter: '2026-05-31T00:00:00.000Z',
      createdAt: '2026-05-30T00:00:00.000Z',
    });
    expect(resume).toBeDefined();
    await claimBillingRuntimeAction(
      db, resume!.id, '2026-05-31T00:00:00.000Z', '2026-05-31T00:05:00.000Z', 5,
    );
    await cancelOutstandingBillingRuntimeActions(
      db,
      'sub_trial',
      'resume',
      '2026-05-31T00:00:01.000Z',
    );
    const resumeForBilling = vi.fn().mockResolvedValue(undefined);

    await expect(dispatchBillingRuntimeActions({
      db,
      customerVpsService: { suspendForBilling: vi.fn(), resumeForBilling },
      now: () => new Date('2026-05-31T00:06:00.000Z'),
    })).resolves.toEqual({ checked: 0, completed: 0, failed: 0, retried: 0 });
    expect(resumeForBilling).not.toHaveBeenCalled();
  });

  it('finishes an immediate compensating suspend before returning when delinquency arrives during a resume call', async () => {
    await enqueueBillingRuntimeAction(db, {
      clerkUserId: 'user_123', runtimeSlot: 'primary', stripeSubscriptionId: 'sub_trial',
      action: 'resume', reason: 'payment_recovered', executeAfter: '2026-05-31T00:00:00.000Z',
      createdAt: '2026-05-30T00:00:00.000Z',
    });
    let releaseResume!: () => void;
    const resumeWait = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const resumeForBilling = vi.fn().mockReturnValue(resumeWait);
    const suspendForBilling = vi.fn().mockResolvedValue(undefined);
    let currentTime = '2026-05-31T00:00:00.000Z';
    const firstDispatch = dispatchBillingRuntimeActions({
      db,
      customerVpsService: { suspendForBilling, resumeForBilling },
      now: () => new Date(currentTime),
    });
    await vi.waitFor(() => expect(resumeForBilling).toHaveBeenCalledOnce());

    await cancelOutstandingBillingRuntimeActions(
      db,
      'sub_trial',
      'resume',
      '2026-05-31T00:00:01.000Z',
    );
    await enqueueBillingRuntimeAction(db, {
      clerkUserId: 'user_123', runtimeSlot: 'primary', stripeSubscriptionId: 'sub_trial',
      action: 'suspend', reason: 'trial_payment_failed', executeAfter: '2026-05-31T00:00:01.000Z',
      createdAt: '2026-05-31T00:00:01.000Z',
    });
    currentTime = '2026-05-31T00:00:01.000Z';
    await expect(dispatchBillingRuntimeActions({
      db,
      customerVpsService: { suspendForBilling, resumeForBilling },
      now: () => new Date(currentTime),
    })).resolves.toEqual({ checked: 0, completed: 0, failed: 0, retried: 0 });
    expect(suspendForBilling).not.toHaveBeenCalled();
    releaseResume();

    await expect(firstDispatch).resolves.toEqual({ checked: 2, completed: 1, failed: 0, retried: 0 });
    expect(suspendForBilling).toHaveBeenCalledOnce();
    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({ action: 'resume', status: 'canceled' }),
      expect.objectContaining({ action: 'suspend', status: 'completed' }),
    ]);
  });

  it('keeps a recovery resume behind an in-flight suspension and completes the compensation before returning', async () => {
    await enqueueBillingRuntimeAction(db, {
      clerkUserId: 'user_123', runtimeSlot: 'primary', stripeSubscriptionId: 'sub_trial',
      action: 'suspend', reason: 'trial_payment_failed', executeAfter: '2026-05-31T00:00:00.000Z',
      createdAt: '2026-05-30T00:00:00.000Z',
    });
    let releaseSuspend!: () => void;
    const suspendWait = new Promise<void>((resolve) => {
      releaseSuspend = resolve;
    });
    const suspendForBilling = vi.fn().mockReturnValue(suspendWait);
    const resumeForBilling = vi.fn().mockResolvedValue(undefined);
    let currentTime = '2026-05-31T00:00:00.000Z';
    const firstDispatch = dispatchBillingRuntimeActions({
      db,
      customerVpsService: { suspendForBilling, resumeForBilling },
      now: () => new Date(currentTime),
    });
    await vi.waitFor(() => expect(suspendForBilling).toHaveBeenCalledOnce());

    await cancelOutstandingBillingRuntimeActions(
      db,
      'sub_trial',
      'suspend',
      '2026-05-31T00:00:01.000Z',
    );
    await enqueueBillingRuntimeAction(db, {
      clerkUserId: 'user_123', runtimeSlot: 'primary', stripeSubscriptionId: 'sub_trial',
      action: 'resume', reason: 'payment_recovered', executeAfter: '2026-05-31T00:00:01.000Z',
      createdAt: '2026-05-31T00:00:01.000Z',
    });
    currentTime = '2026-05-31T00:00:01.000Z';
    releaseSuspend();

    await expect(firstDispatch).resolves.toEqual({ checked: 2, completed: 1, failed: 0, retried: 0 });
    expect(resumeForBilling).toHaveBeenCalledOnce();
    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({ action: 'suspend', status: 'canceled' }),
      expect.objectContaining({ action: 'resume', status: 'completed' }),
    ]);
  });
});
