import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCustomerVpsReconciliationWorker } from '../../packages/platform/src/customer-vps-reconciliation-worker.js';

describe('customer VPS reconciliation worker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a pass immediately and then on the interval', async () => {
    vi.useFakeTimers();
    const runPass = vi.fn(async () => {});
    const worker = startCustomerVpsReconciliationWorker({ intervalMs: 1_000, runPass });
    expect(runPass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runPass).toHaveBeenCalledTimes(2);
    worker.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runPass).toHaveBeenCalledTimes(2);
  });

  it('never overlaps passes and drains the one in flight', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const runPass = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const worker = startCustomerVpsReconciliationWorker({ intervalMs: 1_000, runPass });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(runPass).toHaveBeenCalledTimes(1);

    worker.stop();
    let drained = false;
    const draining = worker.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await draining;
    expect(drained).toBe(true);
  });

  it('drains immediately when no pass is running', async () => {
    const worker = startCustomerVpsReconciliationWorker({ intervalMs: 60_000, runPass: async () => {} });
    await Promise.resolve();
    worker.stop();
    await expect(worker.drain()).resolves.toBeUndefined();
  });
});
