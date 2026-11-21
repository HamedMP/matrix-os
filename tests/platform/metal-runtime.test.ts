import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  METAL_MAINTENANCE_INTERVAL_MS,
  createConfiguredMetalRuntime,
  startMetalMaintenanceWorker,
} from '../../packages/platform/src/substrates/metal-runtime.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createTestConfig } from './customer-vps-service-test-helper.js';

/**
 * Metal maintenance wiring (spec 2691, ENG-520). Faults detected: failed
 * creates whose teardown never drains because nothing schedules the drainer,
 * overlapping passes racing the same rows, one failing step starving the
 * other, a timer that keeps running after shutdown, and metal provisioning
 * composed while metal is disabled or misconfigured.
 */

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('metal maintenance worker', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('runs reconcileStale then drainOnce now and every 60 s', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const worker = startMetalMaintenanceWorker({
      reconcileStale: async () => { calls.push('reconcile'); },
      drainOnce: async () => { calls.push('drain'); },
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['reconcile', 'drain']);
    await vi.advanceTimersByTimeAsync(METAL_MAINTENANCE_INTERVAL_MS);
    expect(calls).toEqual(['reconcile', 'drain', 'reconcile', 'drain']);
    expect(METAL_MAINTENANCE_INTERVAL_MS).toBe(60_000);
    worker.stop();
  });

  it('skips a tick while the previous pass is still running', async () => {
    vi.useFakeTimers();
    const slow = deferred();
    const reconcile = vi.fn(async () => { await slow.promise; });
    const drain = vi.fn(async () => {});
    const worker = startMetalMaintenanceWorker({ reconcileStale: reconcile, drainOnce: drain, intervalMs: 1_000, log: () => {} });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(drain).not.toHaveBeenCalled();
    slow.resolve();
    await worker.drain();
    expect(drain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    worker.stop();
  });

  it('still drains teardowns when reconciliation fails, logging only the error name', async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const drain = vi.fn(async () => {});
    const worker = startMetalMaintenanceWorker({
      reconcileStale: async () => { throw new TypeError('connection to 10.0.0.5 refused'); },
      drainOnce: drain,
      log: (event, fields) => { logs.push({ event, fields }); },
    });
    await worker.drain();
    worker.stop();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([{ event: 'maintenance_step_failed', fields: { step: 'reconcile_stale', code: 'TypeError' } }]);
  });

  it('stops ticking after stop and lets shutdown wait for the pass in flight', async () => {
    vi.useFakeTimers();
    const slow = deferred();
    const drain = vi.fn(async () => { await slow.promise; });
    const reconcile = vi.fn(async () => {});
    const worker = startMetalMaintenanceWorker({ reconcileStale: reconcile, drainOnce: drain, intervalMs: 1_000, log: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    worker.stop();
    let drained = false;
    const draining = worker.drain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    slow.resolve();
    await draining;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('metal runtime composition', () => {
  const db = { kysely: {} } as unknown as PlatformDB;
  const metalEnv = {
    METAL_HOSTS_ENABLED: '1',
    METAL_HOSTD_API_TOKEN: 'a'.repeat(40),
    METAL_HOSTD_INGRESS_TOKEN: 'b'.repeat(40),
    METAL_GOLDEN_VERSION: 'golden-2026.11.20-1',
  };
  const customerVps = { config: createTestConfig() };

  it('is not composed while metal is disabled or incomplete', () => {
    const quiet = { log: () => {} };
    expect(createConfiguredMetalRuntime({ db, env: {}, customerVps, backgroundWorkersEnabled: true, ...quiet })).toBeUndefined();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(createConfiguredMetalRuntime({
        db, env: { ...metalEnv, METAL_GOLDEN_VERSION: '' }, customerVps, backgroundWorkersEnabled: true, ...quiet,
      })).toBeUndefined();
    } finally { errors.mockRestore(); }
  });

  it('is not composed without the customer VPS settings that guest user data needs', () => {
    const logs: string[] = [];
    expect(createConfiguredMetalRuntime({
      db, env: metalEnv, customerVps: undefined, backgroundWorkersEnabled: true, log: (event) => { logs.push(event); },
    })).toBeUndefined();
    expect(logs).toEqual(['metal_provisioning_unconfigured']);
  });

  it('stop clears the maintenance timer and shutdown waits for the pass in flight', async () => {
    vi.useFakeTimers();
    try {
      const runtime = createConfiguredMetalRuntime({ db, env: metalEnv, customerVps, backgroundWorkersEnabled: true, log: () => {} });
      expect(vi.getTimerCount()).toBe(1);
      runtime?.stop();
      expect(vi.getTimerCount()).toBe(0);
      await runtime?.shutdown();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('composes a provisioner without starting maintenance when background workers are off', async () => {
    vi.useFakeTimers();
    try {
      const runtime = createConfiguredMetalRuntime({ db, env: metalEnv, customerVps, backgroundWorkersEnabled: false, log: () => {} });
      expect(runtime?.provisioner.provision).toBeTypeOf('function');
      expect(vi.getTimerCount()).toBe(0);
      await runtime?.shutdown();
    } finally { vi.useRealTimers(); }
  });
});
