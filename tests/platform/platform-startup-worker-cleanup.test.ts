import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlatformStartupWorkerCleanup, runPlatformStartupWithCleanup } from '../../packages/platform/src/platform-startup-cleanup.js';
import { startCustomerVpsReconciliationWorker } from '../../packages/platform/src/customer-vps-reconciliation-worker.js';

describe('platform startup worker lifetime', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('stops production worker timers and waits for every provider pass before closing the pool', async () => {
    vi.useFakeTimers();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    let poolClosed = false;
    const journal = vi.fn(() => { expect(poolClosed).toBe(false); });
    const runFirst = vi.fn(async () => { await first.promise; journal(); });
    const runSecond = vi.fn(async () => { await second.promise; journal(); });
    const workers: ReturnType<typeof startCustomerVpsReconciliationWorker>[] = [];
    const cleanup = createPlatformStartupWorkerCleanup(() => workers);
    const original = new Error('preview credentials unavailable');
    const failed = runPlatformStartupWithCleanup(async register => {
      register(async () => { poolClosed = true; });
      register(cleanup);
      workers.push(startCustomerVpsReconciliationWorker({ intervalMs: 1000, runPass: runFirst }));
      workers.push(startCustomerVpsReconciliationWorker({ intervalMs: 1000, runPass: runSecond }));
      throw original;
    }).catch(error => error);
    await Promise.resolve();
    first.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(poolClosed).toBe(false);
    expect(runFirst).toHaveBeenCalledTimes(1);
    expect(runSecond).toHaveBeenCalledTimes(1);
    second.resolve();
    expect(await failed).toBe(original);
    expect(journal).toHaveBeenCalledTimes(2);
    expect(poolClosed).toBe(true);
    await cleanup();
  });

  it('stops every worker before draining and waits for other drains after one rejects', async () => {
    const pending = Promise.withResolvers<void>();
    const calls: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let poolClosed = false;
    const original = new Error('original failure');
    const cleanup = createPlatformStartupWorkerCleanup(() => [
      { stop() { calls.push('stop-first'); }, async drain() { calls.push('drain-first'); throw new Error('private detail'); } },
      undefined,
      { stop() { calls.push('stop-second'); }, async drain() { calls.push('drain-second'); await pending.promise; expect(poolClosed).toBe(false); } },
    ]);
    const failed = runPlatformStartupWithCleanup(async register => {
      register(async () => { poolClosed = true; });
      register(cleanup);
      throw original;
    }).catch(error => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['stop-first', 'stop-second', 'drain-first', 'drain-second']);
    expect(poolClosed).toBe(false);
    pending.resolve();
    expect(await failed).toBe(original);
    expect(poolClosed).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private detail');
    await expect(cleanup()).rejects.toThrow('Platform startup worker cleanup failed');
    expect(calls).toHaveLength(4);
  });

  it('registers the actual customer, managed-feature and golden workers before startup can fail', () => {
    const source = readFileSync(new URL('../../packages/platform/src/platform-startup.ts', import.meta.url), 'utf8');
    const registration = source.indexOf('registerCustomMcpStartupCleanup(createPlatformStartupWorkerCleanup(');
    expect(registration).toBeGreaterThan(0);
    expect(registration).toBeLessThan(source.indexOf('managedFeatureReconciliationWorker = startCustomerVpsReconciliationWorker'));
    expect(registration).toBeLessThan(source.indexOf('customerVpsReconciliationWorker = startCustomerVpsReconciliationWorker'));
    expect(registration).toBeLessThan(source.indexOf('await createConfiguredPreviewPairRuntime('));
    const wiring = source.slice(registration, source.indexOf('let billingRuntimeCaptureEvent', registration));
    expect(wiring).toContain('customerVpsReconciliationWorker');
    expect(wiring).toContain('managedFeatureReconciliationWorker');
    expect(wiring).toContain('clearInterval(goldenSnapshotInterval)');
    expect(wiring).toContain('goldenSnapshotPromise ?? Promise.resolve()');
    expect(source).toContain('if (goldenSnapshotStopped || goldenSnapshotPromise');
  });
});
