import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertUserMachine, promoteHostBundleChannel, upsertHostBundleRelease, type PlatformDB } from '../../packages/platform/src/db';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper';
import { readBackendPolicy, updateBackendPolicy, setMachineOverride, readBackendStatus, retryMachine } from '../../packages/platform/src/backend-management-repository';
import { reconcileManagedBackend } from '../../packages/platform/src/backend-management-worker';
import { isBackendDowngrade } from '../../packages/platform/src/backend-release-order';

const VERSION = 'v2026.08.28-1';
describe('managed backend reconciliation', () => {
  let db: PlatformDB;
  let now: number;
  const probe = vi.fn();
  const deploy = vi.fn();
  const tick = () => reconcileManagedBackend({ db, probe, deploy, now: () => new Date(now) });
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    now = Date.parse('2026-08-28T12:00:00.000Z');
    probe.mockReset().mockResolvedValue({ version: 'v2026.07.01-1', healthy: true });
    deploy.mockReset().mockResolvedValue(undefined);
    await upsertHostBundleRelease(db, { version: VERSION, gitCommit: 'a'.repeat(40), gitRef: 'main', buildTime: new Date(now).toISOString(), bundleKey: `system-bundles/${VERSION}/matrix-host-bundle.tar.gz`, checksumKey: `system-bundles/${VERSION}/matrix-host-bundle.tar.gz.sha256`, sha256: 'a'.repeat(64), size: 100 });
    await promoteHostBundleChannel(db, 'stable', VERSION);
    for (let i = 0; i < 3; i++) await insertUserMachine(db, { machineId: `machine_${i}`, clerkUserId: `user_${i}`, handle: `person-${i}`, status: 'running', provisioningClass: i === 2 ? 'preview' : 'customer', publicIPv4: '95.216.1.2', provisionedAt: new Date(now).toISOString() });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  async function enable() {
    const policy = await readBackendPolicy(db);
    return updateBackendPolicy(db, { ...policy.config, enabled: true, soakSeconds: 60 }, policy.revision, new Date(now));
  }
  it('defaults off, requires CAS and keeps an audit record', async () => {
    await tick(); expect(deploy).not.toHaveBeenCalled();
    const p = await enable();
    await expect(updateBackendPolicy(db, p.config, 0, new Date(now))).rejects.toThrow('conflict');
    expect(await db.executor.selectFrom('backend_management_audit').selectAll().execute()).toHaveLength(1);
  });
  it('bootstraps old VPSs, verifies installed versions, soaks a canary then advances', async () => {
    await enable(); await tick();
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(deploy.mock.calls[0][1]).toBe(VERSION);
    let status = await readBackendStatus(db);
    expect(status.machines.filter(m => m.status === 'updating')).toHaveLength(1);
    expect(status.machines).toHaveLength(2);
    now += 60_000; probe.mockResolvedValue({ version: VERSION, healthy: true });
    await tick(); expect(deploy).toHaveBeenCalledTimes(1);
    now += 60_000; await tick();
    status = await readBackendStatus(db);
    expect(status.machines.some(m => m.status === 'current')).toBe(true);
  });
  it('leases against duplicate workers and never treats a dispatch as completion', async () => {
    await enable();
    await Promise.all([tick(), tick()]);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect((await readBackendStatus(db)).machines.some(m => m.status === 'current')).toBe(false);
  });
  it('keeps unreachable machines pending for retry without interrupting them', async () => {
    await enable(); probe.mockRejectedValue(new Error('offline'));
    await tick();
    expect(deploy).not.toHaveBeenCalled();
    expect((await readBackendStatus(db)).machines.every(m => m.status === 'offline')).toBe(true);
  });
  it('honors expiring holds and resumes when they expire', async () => {
    await enable();
    await setMachineOverride(db, 'machine_0', { until: new Date(now + 120_000).toISOString(), reason: 'Debugging', allowVersionSelection: true }, new Date(now));
    await tick(); expect(deploy.mock.calls[0][0].machineId).toBe('machine_1');
    expect((await readBackendStatus(db)).machines.find(m => m.machineId === 'machine_0')?.overrideUntil).toBe(new Date(now + 120_000).toISOString());
  });
  it('quarantines an installation that fails verification and allows explicit recovery', async () => {
    await enable(); await tick();
    now += 31 * 60_000; await tick();
    const failed = (await readBackendStatus(db)).machines.find(m => m.status === 'blocked');
    expect(failed).toBeDefined(); expect(deploy).toHaveBeenCalledTimes(1);
    await retryMachine(db, failed!.machineId, new Date(now));
    await tick(); expect(deploy).toHaveBeenCalledTimes(2);
  });
  it('defers a busy runtime without marking a failed deployment', async () => {
    const { ManagedRuntimeBusy } = await import('../../packages/platform/src/backend-management-transport');
    await enable(); deploy.mockRejectedValue(new ManagedRuntimeBusy());
    await tick();
    expect((await readBackendStatus(db)).machines.some(m => m.errorCode === 'runtime_busy')).toBe(true);
    expect((await readBackendStatus(db)).machines.some(m => m.status === 'updating')).toBe(false);
  });
  it('respects an explicitly selected canary', async () => {
    const p = await readBackendPolicy(db);
    await updateBackendPolicy(db, { ...p.config, enabled: true, canaryMachineIds: ['machine_1'] }, p.revision, new Date(now));
    await tick(); expect(deploy.mock.calls[0][0].machineId).toBe('machine_1');
  });

  it('does not dispatch after a pause or deletion while probing', async () => {
    await enable();
    probe.mockImplementation(async () => {
      const p = await readBackendPolicy(db);
      await updateBackendPolicy(db, { ...p.config, enabled: false }, p.revision, new Date(now));
      return { version: 'v2026.07.01-1', healthy: true };
    });
    await tick(); expect(deploy).not.toHaveBeenCalled();
  });
  it('requires another healthy observation after restarting the worker during soak', async () => {
    await enable(); await tick(); now += 60_000;
    probe.mockResolvedValue({ version: VERSION, healthy: true }); await tick();
    now += 60_000; probe.mockRejectedValue(new Error('offline')); await tick();
    expect((await readBackendStatus(db)).machines.some(m => m.status === 'blocked')).toBe(true);
    expect(deploy).toHaveBeenCalledTimes(1);
  });

  it('does not restart a machine deleted during its probe', async () => {
    await enable();
    probe.mockImplementation(async (machine) => {
      await db.executor.updateTable('user_machines').set({ deleted_at: new Date(now).toISOString(), status: 'deleted' }).where('machine_id', '=', machine.machineId).execute();
      return { version: 'v2026.07.01-1', healthy: true };
    });
    await tick(); expect(deploy).not.toHaveBeenCalled();
  });

  it('does not pass a designated canary just because another machine is current', async () => {
    const p = await readBackendPolicy(db);
    await updateBackendPolicy(db, { ...p.config, enabled: true, soakSeconds: 60, canaryMachineIds: ['machine_1'] }, p.revision, new Date(now));
    probe.mockImplementation(async machine => ({ healthy: machine.machineId !== 'machine_1', version: VERSION }));
    await tick(); now += 60_000; await tick(); now += 60_000; await tick();
    probe.mockResolvedValue({ healthy: true, version: 'v2026.07.01-1' });
    now += 300_000; await tick();
    expect(deploy.mock.calls.every(call => call[0].machineId === 'machine_1')).toBe(true);
  });

  it('does not automatically downgrade a recognized newer installed release', async () => {
    await enable(); probe.mockResolvedValue({ version: 'v2026.09.01-1', healthy: true });
    await tick();
    expect(deploy).not.toHaveBeenCalled();
    expect((await readBackendStatus(db)).machines.some(m => m.errorCode === 'newer_release_requires_review')).toBe(true);
  });
  it('recovers uncertain dispatches by observation, never a blind second restart', async () => {
    await enable(); deploy.mockRejectedValue(new Error('connection closed after acceptance'));
    await tick(); expect(deploy).toHaveBeenCalledTimes(1);
    now += 60_000; await tick(); expect(deploy).toHaveBeenCalledTimes(1);
    expect((await readBackendStatus(db)).machines.some(m => m.status === 'updating')).toBe(true);
    probe.mockResolvedValue({ version: VERSION, healthy: true });
    now += 60_000; await tick(); now += 60_000; await tick();
    expect((await readBackendStatus(db)).machines.every(m => m.status === 'current')).toBe(true);
  });
  it('stops before dispatch when its lease expires or shutdown starts during a probe', async () => {
    await enable(); probe.mockImplementation(async () => { now += 121_000; return { healthy: true, version: 'v2026.07.01-1' }; });
    await tick(); expect(deploy).not.toHaveBeenCalled();
    await reconcileManagedBackend({ db, probe, deploy, now: () => new Date(now), shouldStop: () => true });
    expect(deploy).not.toHaveBeenCalled();
  });
  it('does not inventory after losing its lease while reading release metadata', async () => {
    await enable(); let calls = 0;
    await reconcileManagedBackend({ db, probe, deploy, now: () => new Date(now + calls++ * 121_000) });
    expect(deploy).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });
  it('waits for a stable pointer and ignores its accidental backward movement', async () => {
    await enable(); await db.executor.deleteFrom('host_bundle_channels').where('channel', '=', 'stable').execute();
    await reconcileManagedBackend({ db, probe, deploy }); expect(deploy).not.toHaveBeenCalled();
    const release = await db.executor.selectFrom('host_bundle_releases').selectAll().where('version', '=', VERSION).executeTakeFirstOrThrow();
    await db.executor.insertInto('host_bundle_releases').values({ ...release, version: 'v2026.01.01-1', build_time: '2026-01-01T00:00:00.000Z' }).execute();
    await promoteHostBundleChannel(db, 'stable', 'v2026.01.01-1');
    await db.executor.updateTable('backend_management_policy').set({ active_version: VERSION }).where('id', '=', 1).execute();
    probe.mockResolvedValue({ version: VERSION, healthy: true }); await tick();
    expect((await readBackendPolicy(db)).active_version).toBe(VERSION); expect(deploy).not.toHaveBeenCalled();
  });
  it('rechecks holds on queued machines and policy changes before subsequent probes', async () => {
    await enable();
    probe.mockImplementationOnce(async () => {
      await setMachineOverride(db, 'machine_1', { until: new Date(now + 60_000).toISOString(), reason: 'Queued support hold', allowVersionSelection: false }, new Date(now));
      return { version: VERSION, healthy: true };
    });
    await tick(); expect(probe).toHaveBeenCalledTimes(1);
    now += 60_001;
    probe.mockImplementation(async () => {
      const p = await readBackendPolicy(db); await updateBackendPolicy(db, { ...p.config, enabled: false }, p.revision, new Date(now));
      return { version: VERSION, healthy: true };
    });
    await tick(); expect(deploy).not.toHaveBeenCalled();
  });
  it('uses immutable build timestamps for main bundles with unknown calendar ordering', async () => {
    const release = await db.executor.selectFrom('host_bundle_releases').selectAll().where('version', '=', VERSION).executeTakeFirstOrThrow();
    await db.executor.insertInto('host_bundle_releases').values({ ...release, version: 'main-older', build_time: '2026-01-01T00:00:00.000Z' }).execute();
    expect(await isBackendDowngrade(db, 'main-older', VERSION)).toBe(true);
    expect(await isBackendDowngrade(db, VERSION, 'main-older')).toBe(false);
    expect(await isBackendDowngrade(db, VERSION, 'unknown-legacy')).toBe(false);
  });

  it('converges a hundred legacy machines with bounded cohorts and restart-safe verification', async () => {
    for (let i = 3; i < 101; i++) await insertUserMachine(db, { machineId: `machine_${i}`, clerkUserId: `user_${i}`, handle: `person-${i}`, status: 'running', publicIPv4: '95.216.1.2', provisionedAt: new Date(now).toISOString() });
    const installed = new Map<string, string>(); // Fixed test inventory: 100 machines.
    probe.mockImplementation(async m => ({ version: installed.get(m.machineId) ?? 'v2026.07.01-1', healthy: true }));
    deploy.mockImplementation(async (m, version) => { installed.set(m.machineId, version); });
    const enabled = await enable();
    await updateBackendPolicy(db, { ...enabled.config, canaryMachineIds: ['machine_0'] }, enabled.revision, new Date(now));
    for (let iteration = 0; iteration < 150; iteration++) {
      const before = deploy.mock.calls.length;
      await tick();
      expect(deploy.mock.calls.length - before).toBeLessThanOrEqual(5);
      now += 60_000;
      if ((await readBackendStatus(db)).machines.every(m => m.status === 'current')) break;
    }
    expect(installed.size).toBe(100);
    expect((await readBackendStatus(db)).machines.every(m => m.status === 'current')).toBe(true);
  }, 60_000);

});
