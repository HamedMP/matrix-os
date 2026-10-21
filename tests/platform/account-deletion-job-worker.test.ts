import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAccountDeletionWorker } from '../../packages/platform/src/account-deletion/worker.js';
import type { AccountDeletionService } from '../../packages/platform/src/account-deletion/types.js';

describe('account deletion worker lifecycle', () => {
  afterEach(() => vi.useRealTimers());
  it('starts immediately, never overlaps passes, and drains before shutdown', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const reconcile = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const worker = startAccountDeletionWorker({ service: { reconcile } as unknown as AccountDeletionService, intervalMs: 1000 });
    expect(reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconcile).toHaveBeenCalledOnce();
    let drained = false;
    const draining = worker.drain().then(() => { drained = true; });
    worker.stop();
    expect(drained).toBe(false);
    finish();
    await draining;
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(drained).toBe(true);
  });
  it('logs failures and permits a later retry', async () => {
    vi.useFakeTimers();
    const error = new Error('database unavailable');
    const reconcile = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const logError = vi.fn();
    const worker = startAccountDeletionWorker({ service: { reconcile } as unknown as AccountDeletionService, intervalMs: 1000, logError });
    await worker.drain();
    expect(logError).toHaveBeenCalledWith(error);
    await vi.advanceTimersByTimeAsync(1000);
    await worker.drain();
    expect(reconcile).toHaveBeenCalledTimes(2);
    worker.stop();
  });
});
