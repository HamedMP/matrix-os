import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupExpiredReservations } from '../../packages/platform/src/ai-funded-reservation-cleanup.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';

/**
 * ENG-520 P7 fix round 1: a failing free prepaid-hold sweep must not starve
 * paid expired-charge cleanup. Fault detected: one transient free-sweep error
 * skipping paid cleanup and priority-claim deletion for the whole tick.
 */

const order: string[] = [];
vi.mock('../../packages/platform/src/free-tier/prepaid-unknown-usage.js', () => ({
  releaseUnknownFreeHolds: vi.fn(async () => { order.push('free'); throw new Error('connection terminated'); }),
}));
vi.mock('../../packages/platform/src/ai-funded-customer-credit-cleanup.js', () => ({
  cleanupExpiredCustomerCharges: vi.fn(async () => { order.push('paid'); return 3; }),
}));
vi.mock('../../packages/platform/src/ai-funded-priority-claims.js', () => ({
  deleteExpiredPriorityClaims: vi.fn(async () => { order.push('claims'); return 0; }),
}));

describe('funded reservation cleanup with a failing free sweep', () => {
  afterEach(() => { order.length = 0; vi.restoreAllMocks(); });

  it('still runs paid cleanup and claim deletion, logs the failure, then reports it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = { ready: Promise.resolve(), executor: {} } as unknown as PlatformDB;
    await expect(cleanupExpiredReservations({ db, now: () => new Date('2026-11-20T12:00:00.000Z') }, { limit: 10 }))
      .rejects.toThrow('connection terminated');
    expect(order).toEqual(['free', 'paid', 'claims']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Free prepaid hold sweep failed'), { errorName: 'Error' });
  });
});
