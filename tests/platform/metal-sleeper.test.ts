import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeLifecycleStatus } from '@matrix-os/contracts/runtime-lifecycle';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { getRuntimeEntitlementDecisionForUser } from '../../packages/platform/src/runtime-entitlement.js';
import { resolveEffectiveBillingEntitlementForSlot } from '../../packages/platform/src/billing-entitlement-resolver.js';
import type { BillingEntitlement } from '../../packages/platform/src/billing.js';
import {
  getUserMachine,
  insertUserMachine,
  upsertBillingEntitlement,
  upsertBillingSubscription,
  type NewUserMachine,
  type PlatformDB,
  type UserMachineRecord,
} from '../../packages/platform/src/db.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { createFreeTierSleepSwitch } from '../../packages/platform/src/free-tier/switches.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import {
  IDLE_GUARD_AFTER_MS,
  IDLE_SLEEP_AFTER_MS,
  LIFECYCLE_ALERT_AFTER_MS,
  METAL_SLEEP_INTERVAL_MS,
  METAL_WAKE_INTERVAL_MS,
  SCHEDULED_WAKE_LEAD_MS,
  SLEEP_PASS_BUDGET_MS,
  SLEEP_RECHECK_AFTER_MS,
  WAKE_PASS_BUDGET_MS,
  WAKE_RETRY_MAX_MS,
  createMetalSleeper,
  startMetalSleeperWorker,
  type LifecycleRead,
  type MetalSleeperDeps,
} from '../../packages/platform/src/substrates/metal-sleeper.js';
import { createLifecycleReader } from '../../packages/platform/src/substrates/metal-lifecycle-reader.js';
import { createMetalHostDirectory, createMetalSubstrate, HOST_AUTH_HEADER } from '../../packages/platform/src/substrates/metal-substrate.js';
import { createSubstrateRegistry } from '../../packages/platform/src/substrates/registry.js';
import { WAKE_TIMEOUT_MS } from '../../packages/platform/src/substrates/substrate-wake.js';
import type {
  EnsureRunningResult,
  OnDemandRuntimeSubstrate,
  RuntimeUpstream,
  StopRuntimeResult,
} from '../../packages/platform/src/substrates/types.js';
import { generateSelfSignedCert, json, startFakeHostd, type FakeHostd } from './fake-hostd-server.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

/**
 * Idle sleep and scheduled wake for free metal runtimes (spec 2691, ENG-520
 * Task P6). Faults detected: a free VM kept awake (and paid for) after an hour
 * with nothing running; a VM suspended under a running agent turn, routine, or
 * an unknown or incomplete lifecycle answer; a VM that never sleeps because a
 * stuck job reports busy forever; a paid VM put to sleep; a scheduled job that
 * misses its time because the VM is asleep; a failed suspend recorded as
 * asleep; a sleeper acting on a replaced runtime; and a lost wake never retried.
 */

const NOW = new Date('2026-11-21T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GENERATION = 3;
const VM_ID = 'vm_0123456789abcdef01234567';

const IDLE: RuntimeLifecycleStatus = { busy: false, busyReasons: [], nextScheduledAt: null, scheduleComplete: true };

function ago(ms: number, from = NOW): string {
  return new Date(from.getTime() - ms).toISOString();
}

function paidEntitlement(owner: string): BillingEntitlement {
  return {
    ...buildFreeEntitlement(owner, NOW), source: 'stripe', planSlug: 'matrix_starter', status: 'active',
    defaultServerType: 'cpx22', allowedServerTypes: ['cpx22'], stripeSubscriptionId: 'sub_1', stripePriceId: 'price_1',
  };
}

function fakeSubstrate() {
  const stop = vi.fn(async (): Promise<StopRuntimeResult> => ({ state: 'stopping' }));
  const ensureRunning = vi.fn(async (): Promise<EnsureRunningResult> => ({ state: 'running' }));
  const isSuspended = vi.fn(async () => true);
  const substrate: OnDemandRuntimeSubstrate = {
    kind: 'metal', startsOnDemand: true, resolveUpstream: () => null, stop, ensureRunning, isSuspended,
  };
  return { substrate, stop, ensureRunning, isSuspended };
}

describe('metal idle sleeper', () => {
  let db: PlatformDB;
  let seq: number;
  let logs: Array<{ event: string; fields: Record<string, unknown> }>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await createMetalHostsRepository(db.kysely).upsert({
      id: 'host-a', name: 'host-a', apiUrl: 'https://host-a.metal.example.test:8443', ingressHost: 'host-a.metal.example.test',
      status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
    });
    seq = 0;
    logs = [];
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  /** A free (default) or paid metal runtime, idle for 61 minutes and awake for 2 hours unless overridden. */
  async function seedMachine(options: { paid?: boolean; overrides?: Partial<NewUserMachine> } = {}): Promise<string> {
    seq += 1;
    const owner = `user_owner${seq}`;
    const machineId = `metal-machine-${seq}`;
    await upsertBillingEntitlement(db, options.paid ? paidEntitlement(owner) : buildFreeEntitlement(owner, NOW));
    await insertUserMachine(db, {
      machineId, clerkUserId: owner, handle: `owner${seq}`, status: 'running', imageVersion: 'matrix-os-host-dev',
      provisionedAt: '2026-11-01T00:00:00.000Z', substrate: 'metal', generation: GENERATION,
      metalHostId: 'host-a', metalVmId: VM_ID, hetznerServerId: null, publicIPv4: null,
      lastActivityAt: ago(61 * MINUTE), awakeSince: ago(2 * HOUR),
      ...options.overrides,
    });
    return machineId;
  }

  async function machine(machineId: string): Promise<UserMachineRecord> {
    const row = await getUserMachine(db, machineId);
    if (!row) throw new Error('machine missing');
    return row;
  }

  function sleeper(overrides: Partial<MetalSleeperDeps> & { lifecycle?: LifecycleRead | ((m: UserMachineRecord) => Promise<LifecycleRead>) } = {}) {
    const fake = fakeSubstrate();
    const lifecycle = overrides.lifecycle ?? { ok: true, status: IDLE };
    const readLifecycle = vi.fn(async (m: UserMachineRecord) => (typeof lifecycle === 'function' ? lifecycle(m) : lifecycle));
    const instance = createMetalSleeper({
      db,
      substrate: fake.substrate,
      readLifecycle,
      log: (event, fields) => { logs.push({ event, fields }); },
      ...overrides,
    });
    return { sleeper: instance, readLifecycle, ...fake };
  }

  it('sleeps a free VM idle for 60 minutes with nothing running', async () => {
    const idle = await seedMachine();
    const active = await seedMachine({ overrides: { lastActivityAt: ago(30 * MINUTE) } });
    const { sleeper: s, stop, readLifecycle } = sleeper();

    await s.tick(NOW);

    expect(IDLE_SLEEP_AFTER_MS).toBe(HOUR);
    expect(readLifecycle).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.calls[0]?.[0]).toMatchObject({ machineId: idle, generation: GENERATION });
    expect(await machine(idle)).toMatchObject({ status: 'suspended', nextWakeAt: null, idleGuardAt: null, awakeSince: null });
    expect(await machine(active)).toMatchObject({ status: 'running' });
  });

  it.each(['running', 'suspended'] as const)('keeps a %s computer reachable during deletion grace', async (status) => {
    const id = await seedMachine({ overrides: { status, activationState: 'authorized' } });
    const owner = (await machine(id)).clerkUserId;
    const secret = 'deletion-test-secret'.repeat(2);
    const env = { ACCOUNT_DELETION_SECRET: secret };
    const deletion = new AccountDeletionRepository(db.kysely, { secret, now: () => NOW });
    const job = await deletion.accept({ clerkUserId: owner, appleTokens: [] }, false);
    const { sleeper: s, stop } = sleeper({ env });

    await s.sleepTick(NOW);

    expect(stop).not.toHaveBeenCalled();
    expect((await machine(id)).status).toBe(status);
    expect(await getRuntimeEntitlementDecisionForUser(db, owner, env, 'primary', 'customer', NOW))
      .toMatchObject({ runtimeProxyAllowed: true });
    expect(await getRuntimeEntitlementDecisionForUser(db, owner, env, 'primary', 'customer', new Date(job.due_at)))
      .toMatchObject({ runtimeProxyAllowed: false });
  });

  it('sleeps a VM with no owner activity once it has been awake for 60 minutes', async () => {
    const fresh = await seedMachine({ overrides: { lastActivityAt: null, awakeSince: ago(10 * MINUTE) } });
    const stale = await seedMachine({ overrides: { lastActivityAt: null, awakeSince: ago(61 * MINUTE) } });
    const { sleeper: s, stop } = sleeper();

    await s.tick(NOW);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(await machine(stale)).toMatchObject({ status: 'suspended' });
    expect(await machine(fresh)).toMatchObject({ status: 'running' });
  });

  it('stamps awake_since on a running metal VM that has none, so it can sleep later', async () => {
    const id = await seedMachine({ overrides: { lastActivityAt: null, awakeSince: null } });
    const { sleeper: s, stop } = sleeper();

    await s.tick(NOW);
    expect(stop).not.toHaveBeenCalled();
    expect(await machine(id)).toMatchObject({ status: 'running', awakeSince: NOW.toISOString() });

    await s.tick(new Date(NOW.getTime() + 61 * MINUTE));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not sleep while lifecycle reports busy', async () => {
    const id = await seedMachine();
    const { sleeper: s, stop } = sleeper({ lifecycle: { ok: true, status: { ...IDLE, busy: true, busyReasons: ['chat_run'] } } });

    await s.tick(NOW);

    expect(stop).not.toHaveBeenCalled();
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null });
  });

  it('suspends and flags after 6 hours awake with no owner activity', async () => {
    const stuck = await seedMachine({ overrides: { awakeSince: ago(IDLE_GUARD_AFTER_MS), lastActivityAt: ago(IDLE_GUARD_AFTER_MS + MINUTE) } });
    const recentOwner = await seedMachine({ overrides: { awakeSince: ago(7 * HOUR), lastActivityAt: ago(2 * HOUR) } });
    const { sleeper: s, stop } = sleeper({ lifecycle: { ok: true, status: { ...IDLE, busy: true, busyReasons: ['routine', 'background_agent'] } } });

    await s.tick(NOW);

    expect(IDLE_GUARD_AFTER_MS).toBe(6 * HOUR);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await machine(stuck)).toMatchObject({ status: 'suspended', idleGuardAt: NOW.toISOString() });
    expect(await machine(recentOwner)).toMatchObject({ status: 'running', idleGuardAt: null });
    expect(logs).toContainEqual({
      event: 'idle_guard_suspended',
      fields: { machineId: stuck, busyReasons: ['routine', 'background_agent'] },
    });
  });

  const stripeEnv = { MATRIX_BILLING_PROVIDER: 'stripe', STRIPE_PRICE_MATRIX_STARTER_MONTHLY: 'price_1' };

  async function changePlan(owner: string, failedTrial = false) {
    await upsertBillingSubscription(db, {
      clerkUserId: owner, runtimeSlot: 'primary', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1',
      planSlug: 'matrix_starter', stripePriceId: 'price_1', billingInterval: 'monthly', status: 'active',
      ...(failedTrial ? { trialEndsAt: NOW.toISOString(), firstTrialPaymentFailedAt: NOW.toISOString() } : {}),
      currentPeriodEnd: new Date(NOW.getTime() + HOUR).toISOString(), gracePeriodEndsAt: null,
      latestEventCreatedAt: NOW.toISOString(), latestEventId: 'evt_upgrade', updatedAt: NOW.toISOString(),
    });
    await upsertBillingEntitlement(db, paidEntitlement(owner));
  }

  it.each(['lifecycle read', 'host suspend', 'lost suspend response'] as const)(
    'keeps a paid computer running after an upgrade during the %s', async (when) => {
      const id = await seedMachine();
      const owner = (await machine(id)).clerkUserId;
      const { sleeper: s, stop, ensureRunning } = sleeper({
        env: stripeEnv,
        lifecycle: async () => {
          if (when === 'lifecycle read') await changePlan(owner);
          return { ok: true, status: IDLE };
        },
      });
      if (when !== 'lifecycle read') {
        stop.mockImplementationOnce(async () => {
          await changePlan(owner);
          if (when === 'lost suspend response') throw new Error('Host suspend response was lost');
          return { state: 'stopping' };
        });
      }

      await s.sleepTick(NOW);

      expect((await resolveEffectiveBillingEntitlementForSlot(db, owner, NOW, 'primary', stripeEnv))?.source).toBe('stripe');
      expect(stop).toHaveBeenCalledTimes(when === 'lifecycle read' ? 0 : 1);
      expect(ensureRunning).toHaveBeenCalledTimes(when === 'lifecycle read' ? 0 : 1);
      const runtime = await machine(id);
      expect(runtime.status).toBe('running');
      if (when === 'lost suspend response') expect(runtime.nextWakeAt).not.toBeNull();
      else expect(runtime.nextWakeAt).toBeNull();
    },
  );

  it('does not wake a billing-suspended computer for a saved scheduled job', async () => {
    const id = await seedMachine({ overrides: { status: 'suspended', nextWakeAt: ago(MINUTE) } });
    await changePlan((await machine(id)).clerkUserId, true);
    const { sleeper: s, ensureRunning } = sleeper({ env: stripeEnv });

    await s.wakeTick(NOW);

    expect(ensureRunning).not.toHaveBeenCalled();
    expect((await machine(id)).status).toBe('suspended');
  });

  it('free-tier-sleep off skips suspends but scheduled wakes still run (ENG-608)', async () => {
    const idle = await seedMachine();
    const asleep = await seedMachine({ overrides: { status: 'suspended', nextWakeAt: ago(MINUTE) } });
    const evaluate = vi.fn(async () => false);
    const flags = { configured: true, evaluate, shutdown: async () => undefined };
    const { sleeper: s, stop, ensureRunning, readLifecycle } = sleeper({ sleepAllowed: createFreeTierSleepSwitch(flags) });

    await s.tick(NOW);

    expect(stop).not.toHaveBeenCalled();
    expect(readLifecycle).not.toHaveBeenCalled();
    expect(await machine(idle)).toMatchObject({ status: 'running' });
    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(ensureRunning.mock.calls[0]?.[0]).toMatchObject({ machineId: asleep });
    expect(evaluate).toHaveBeenCalledWith('free-tier-sleep', { distinctId: (await machine(idle)).clerkUserId });
    expect(logs).toContainEqual({ event: 'sleep_skipped_flag', fields: { machineId: idle } });

    // Cold start (definitions not loaded) also keeps runtimes awake; turning the flag on resumes sleeping.
    evaluate.mockResolvedValue(undefined as never);
    await s.tick(new Date(NOW.getTime() + SLEEP_RECHECK_AFTER_MS));
    expect(stop).not.toHaveBeenCalled();
    evaluate.mockResolvedValue(true);
    await s.tick(new Date(NOW.getTime() + 2 * SLEEP_RECHECK_AFTER_MS));
    expect(stop.mock.calls.map(([ref]) => (ref as { machineId: string }).machineId)).toContain(idle);
    expect(await machine(idle)).toMatchObject({ status: 'suspended' });
  });

  it('never sleeps paid VMs', async () => {
    const paid = await seedMachine({ paid: true, overrides: { awakeSince: ago(10 * HOUR), lastActivityAt: ago(10 * HOUR) } });
    const { sleeper: s, stop, readLifecycle } = sleeper();

    await s.tick(NOW);

    expect(readLifecycle).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(await machine(paid)).toMatchObject({ status: 'running' });
  });

  it('wakes early enough that a scan just missing the wake time still leaves the wake pass and a resume before the job', async () => {
    const scheduledAt = new Date(NOW.getTime() + HOUR);
    const id = await seedMachine();
    const { sleeper: s, ensureRunning } = sleeper({
      lifecycle: { ok: true, status: { ...IDLE, nextScheduledAt: scheduledAt.toISOString() } },
    });

    await s.tick(NOW);
    const wakeAt = Date.parse((await machine(id)).nextWakeAt!);
    // Worst case: one scan runs just before the saved wake time, the next a full interval later.
    await s.tick(new Date(wakeAt - 1));
    expect(ensureRunning).not.toHaveBeenCalled();
    const firstWakeScan = wakeAt - 1 + METAL_SLEEP_INTERVAL_MS;
    await s.tick(new Date(firstWakeScan));
    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(scheduledAt.getTime() - firstWakeScan).toBeGreaterThanOrEqual(WAKE_PASS_BUDGET_MS + WAKE_TIMEOUT_MS);
  });

  it('wakes SCHEDULED_WAKE_LEAD_MS before nextScheduledAt', async () => {
    const scheduledAt = new Date(NOW.getTime() + HOUR);
    const id = await seedMachine();
    const { sleeper: s, stop, ensureRunning } = sleeper({
      lifecycle: { ok: true, status: { ...IDLE, nextScheduledAt: scheduledAt.toISOString() } },
    });

    await s.tick(NOW);
    const wakeAt = new Date(scheduledAt.getTime() - SCHEDULED_WAKE_LEAD_MS);
    expect(SCHEDULED_WAKE_LEAD_MS).toBe(2 * MINUTE);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await machine(id)).toMatchObject({ status: 'suspended', nextWakeAt: wakeAt.toISOString() });

    await s.tick(new Date(wakeAt.getTime() - 1_000));
    expect(ensureRunning).not.toHaveBeenCalled();

    await s.tick(wakeAt);
    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(ensureRunning.mock.calls[0]?.[0]).toMatchObject({ machineId: id, generation: GENERATION });
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null, awakeSince: wakeAt.toISOString() });
  });

  it('does not sleep when the next scheduled job is due within 60 s', async () => {
    const id = await seedMachine();
    const { sleeper: s, stop } = sleeper({
      lifecycle: { ok: true, status: { ...IDLE, nextScheduledAt: new Date(NOW.getTime() + 30_000).toISOString() } },
    });

    await s.tick(NOW);

    expect(stop).not.toHaveBeenCalled();
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null });
  });

  it('sleeper leaves running on suspend failure, keeping the saved wake in case the host suspended it anyway', async () => {
    const id = await seedMachine();
    const scheduledAt = new Date(NOW.getTime() + HOUR);
    const { sleeper: s, stop } = sleeper({
      lifecycle: { ok: true, status: { ...IDLE, nextScheduledAt: scheduledAt.toISOString() } },
    });
    stop.mockResolvedValueOnce({ state: 'failed', code: 'provider_unavailable' });

    await s.tick(NOW);

    expect(stop).toHaveBeenCalledTimes(1);
    const wakeAt = new Date(scheduledAt.getTime() - SCHEDULED_WAKE_LEAD_MS).toISOString();
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: wakeAt, idleGuardAt: null });
    expect(logs).toContainEqual({ event: 'sleep_suspend_failed', fields: { machineId: id, code: 'provider_unavailable' } });
  });

  it('a suspend whose answer was lost still wakes the VM for its scheduled job', async () => {
    const id = await seedMachine();
    const scheduledAt = new Date(NOW.getTime() + HOUR);
    let asleep = false;
    const { sleeper: s, stop, ensureRunning } = sleeper({
      lifecycle: async () => (asleep ? { ok: false, code: 'asleep' }
        : { ok: true, status: { ...IDLE, nextScheduledAt: scheduledAt.toISOString() } }),
    });
    // hostd suspended the VM, but its answer never arrived.
    stop.mockImplementationOnce(async () => { asleep = true; throw new DOMException('timed out', 'TimeoutError'); });

    await s.tick(NOW);
    await s.tick(new Date(NOW.getTime() + 6 * MINUTE));
    const wakeAt = new Date(scheduledAt.getTime() - SCHEDULED_WAKE_LEAD_MS);
    expect(await machine(id)).toMatchObject({ status: 'suspended', nextWakeAt: wakeAt.toISOString() });

    await s.tick(wakeAt);
    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null });
  });

  it('wakes after a lost suspend answer even before the next lifecycle check', async () => {
    const id = await seedMachine();
    const scheduledAt = new Date(NOW.getTime() + 3 * MINUTE);
    let asleep = false;
    const { sleeper: s, stop, ensureRunning } = sleeper({
      lifecycle: async () => (asleep ? { ok: false, code: 'asleep' }
        : { ok: true, status: { ...IDLE, nextScheduledAt: scheduledAt.toISOString() } }),
    });
    // hostd suspended the VM, but its answer never arrived.
    stop.mockImplementationOnce(async () => { asleep = true; throw new DOMException('timed out', 'TimeoutError'); });

    await s.tick(NOW);
    const wakeAt = new Date(scheduledAt.getTime() - SCHEDULED_WAKE_LEAD_MS);
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: wakeAt.toISOString() });

    await s.tick(wakeAt);
    await s.tick(new Date(wakeAt.getTime() + MINUTE));
    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null });
  });

  it('lifecycle timeout skips the machine this tick', async () => {
    const slow = await seedMachine();
    const ok = await seedMachine();
    const { sleeper: s, stop } = sleeper({
      lifecycle: async (m) => (m.machineId === slow ? { ok: false, code: 'timeout' } : { ok: true, status: IDLE }),
    });

    await s.tick(NOW);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.calls[0]?.[0]).toMatchObject({ machineId: ok });
    expect(await machine(slow)).toMatchObject({ status: 'running' });
    expect(await machine(ok)).toMatchObject({ status: 'suspended' });
  });

  it('a lifecycle reader that throws skips only that machine', async () => {
    const broken = await seedMachine();
    const ok = await seedMachine();
    const { sleeper: s, stop } = sleeper({
      lifecycle: async (m) => {
        if (m.machineId === broken) throw new TypeError('socket hang up at 10.0.0.5');
        return { ok: true, status: IDLE };
      },
    });

    await s.tick(NOW);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(await machine(broken)).toMatchObject({ status: 'running' });
    expect(logs).toContainEqual({ event: 'lifecycle_read_failed', fields: { machineId: broken, code: 'TypeError' } });
  });

  it('does not sleep when scheduleComplete is false', async () => {
    const id = await seedMachine({ overrides: { awakeSince: ago(7 * HOUR), lastActivityAt: ago(7 * HOUR) } });
    const { sleeper: s, stop } = sleeper({ lifecycle: { ok: true, status: { ...IDLE, scheduleComplete: false } } });

    await s.tick(NOW);

    expect(stop).not.toHaveBeenCalled();
    expect(await machine(id)).toMatchObject({ status: 'running' });
  });

  it('does not sleep when busyReasons contains unknown', async () => {
    // Past the 6 h guard too: the guard never overrides an unknown busy source.
    const id = await seedMachine({ overrides: { awakeSince: ago(7 * HOUR), lastActivityAt: ago(7 * HOUR) } });
    const { sleeper: s, stop } = sleeper({
      lifecycle: { ok: true, status: { ...IDLE, busy: true, busyReasons: ['chat_run', 'unknown'] } },
    });

    await s.tick(NOW);

    expect(stop).not.toHaveBeenCalled();
    expect(await machine(id)).toMatchObject({ status: 'running', idleGuardAt: null });
  });

  it('stale generation CAS loses and does not stop', async () => {
    const id = await seedMachine();
    const { sleeper: s, stop } = sleeper({
      lifecycle: async () => {
        // The runtime is replaced while the sleeper reads its lifecycle.
        await db.executor.updateTable('user_machines').set({ generation: GENERATION + 1 })
          .where('machine_id', '=', id).execute();
        return { ok: true, status: IDLE };
      },
    });

    await s.tick(NOW);

    expect(stop).not.toHaveBeenCalled();
    expect(await machine(id)).toMatchObject({ status: 'running', generation: GENERATION + 1, nextWakeAt: null });
  });

  it('owner activity during the lifecycle read keeps the VM awake', async () => {
    const id = await seedMachine();
    const { sleeper: s, stop } = sleeper({
      lifecycle: async () => {
        await db.executor.updateTable('user_machines').set({ last_activity_at: NOW })
          .where('machine_id', '=', id).execute();
        return { ok: true, status: IDLE };
      },
    });

    await s.tick(NOW);

    expect(stop).not.toHaveBeenCalled();
    expect(await machine(id)).toMatchObject({ status: 'running' });
  });

  it('wake failure is retried next tick', async () => {
    const id = await seedMachine({ overrides: { status: 'suspended', nextWakeAt: ago(MINUTE), awakeSince: null } });
    const { sleeper: s, ensureRunning } = sleeper();
    ensureRunning.mockResolvedValueOnce({ state: 'failed', code: 'provider_unavailable' });

    await s.tick(NOW);
    // Backed off by one minute behind fresh wakes.
    expect(await machine(id)).toMatchObject({ status: 'suspended', nextWakeAt: new Date(NOW.getTime() + MINUTE).toISOString() });
    expect(logs).toContainEqual({ event: 'scheduled_wake_failed', fields: { machineId: id, state: 'failed', code: 'provider_unavailable' } });

    const later = new Date(NOW.getTime() + METAL_SLEEP_INTERVAL_MS);
    await s.tick(later);
    expect(ensureRunning).toHaveBeenCalledTimes(2);
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null, awakeSince: later.toISOString() });
  });

  it('a runtime that needs recovery stops being woken and is logged for an operator', async () => {
    const id = await seedMachine({ overrides: { status: 'suspended', nextWakeAt: ago(MINUTE), awakeSince: null } });
    const { sleeper: s, ensureRunning } = sleeper();
    ensureRunning.mockResolvedValue({ state: 'failed', code: 'needs_recovery' });

    await s.tick(NOW);
    await s.tick(new Date(NOW.getTime() + METAL_SLEEP_INTERVAL_MS));

    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(await machine(id)).toMatchObject({ status: 'suspended', nextWakeAt: null });
    expect(logs).toContainEqual({ event: 'scheduled_wake_needs_recovery', fields: { machineId: id } });
  });

  it('drains every due wake within one pass, 20 at a time, earliest first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 45; i += 1) {
      ids.push(await seedMachine({ overrides: { status: 'suspended', nextWakeAt: ago((60 - i) * MINUTE), awakeSince: null } }));
    }
    let inFlight = 0;
    let peak = 0;
    const { sleeper: s, ensureRunning } = sleeper();
    ensureRunning.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { state: 'running' };
    });

    await s.tick(NOW);

    expect(ensureRunning).toHaveBeenCalledTimes(45);
    expect(ensureRunning.mock.calls.map((call) => call[0].machineId)).toEqual(ids);
    expect(peak).toBeLessThanOrEqual(20);
  });

  it('wakes each due row at most once per pass while draining', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      ids.push(await seedMachine({ overrides: { status: 'suspended', nextWakeAt: ago((30 - i) * MINUTE), awakeSince: null } }));
    }
    const { sleeper: s, ensureRunning } = sleeper();
    // A wake still in progress keeps the row asleep and due on a later scan.
    ensureRunning.mockResolvedValue({ state: 'starting' });

    await s.tick(NOW);

    expect(ensureRunning).toHaveBeenCalledTimes(25);
    expect(new Set(ensureRunning.mock.calls.map((call) => call[0].machineId))).toEqual(new Set(ids));
  });

  it('stops fetching more due wakes once the wake pass budget is spent', async () => {
    for (let i = 0; i < 25; i += 1) {
      await seedMachine({ overrides: { status: 'suspended', nextWakeAt: ago((30 - i) * MINUTE), awakeSince: null } });
    }
    let clock = 0;
    const { sleeper: s, ensureRunning } = sleeper({ elapsedMs: () => clock });
    ensureRunning.mockImplementation(async () => { clock = WAKE_PASS_BUDGET_MS; return { state: 'running' }; });

    await s.tick(NOW);

    expect(ensureRunning).toHaveBeenCalledTimes(20);
  });

  it('more than 50 always-skipped candidates still let a sleepable VM sleep', async () => {
    const stuck = new Set<string>();
    for (let i = 0; i < 51; i += 1) {
      stuck.add(await seedMachine({ overrides: { lastActivityAt: ago(3 * HOUR + i * MINUTE) } }));
    }
    const idle = await seedMachine();
    const { sleeper: s, readLifecycle } = sleeper({
      lifecycle: async (m) => (stuck.has(m.machineId) ? { ok: false, code: 'unreachable' } : { ok: true, status: IDLE }),
    });

    await s.tick(NOW);
    expect(await machine(idle)).toMatchObject({ status: 'running' });
    await s.tick(new Date(NOW.getTime() + METAL_SLEEP_INTERVAL_MS));

    expect(SLEEP_RECHECK_AFTER_MS).toBe(5 * MINUTE);
    expect(await machine(idle)).toMatchObject({ status: 'suspended' });
    // Each stuck runtime is read once, then rotated behind the others until its recheck time.
    expect(readLifecycle).toHaveBeenCalledTimes(52);
  });

  it('more than 20 failing due wakes still let other due wakes run, and failures back off up to 15 minutes', async () => {
    const failing = new Set<string>();
    for (let i = 0; i < 21; i += 1) {
      failing.add(await seedMachine({ overrides: { status: 'suspended', nextWakeAt: ago((40 - i) * MINUTE), awakeSince: null } }));
    }
    const healthy = await seedMachine({ overrides: { status: 'suspended', nextWakeAt: ago(MINUTE), awakeSince: null } });
    const { sleeper: s, ensureRunning } = sleeper();
    ensureRunning.mockImplementation(async (ref) => (failing.has(ref.machineId)
      ? { state: 'failed', code: 'provider_unavailable' }
      : { state: 'running' }));

    await s.tick(NOW);
    const first = [...failing][0]!;
    expect(await machine(first)).toMatchObject({ status: 'suspended', nextWakeAt: new Date(NOW.getTime() + MINUTE).toISOString() });
    await s.tick(new Date(NOW.getTime() + 1_000));
    expect(await machine(healthy)).toMatchObject({ status: 'running' });

    // Doubling backoff, capped.
    let at = new Date(NOW.getTime() + MINUTE);
    for (const delay of [2, 4, 8, 15, 15]) {
      await s.tick(at);
      const next = (await machine(first)).nextWakeAt;
      expect(next).toBe(new Date(at.getTime() + delay * MINUTE).toISOString());
      at = new Date(next!);
    }
    expect(WAKE_RETRY_MAX_MS).toBe(15 * MINUTE);
  });

  it('records a VM the host already put to sleep as asleep, keeping its scheduled wake', async () => {
    const wakeAt = new Date(NOW.getTime() + 30 * MINUTE).toISOString();
    const id = await seedMachine({ overrides: { nextWakeAt: wakeAt } });
    const { sleeper: s, stop, ensureRunning } = sleeper({ lifecycle: { ok: false, code: 'asleep' } });

    await s.tick(NOW);
    expect(stop).not.toHaveBeenCalled();
    expect(await machine(id)).toMatchObject({ status: 'suspended', nextWakeAt: wakeAt });

    await s.tick(new Date(wakeAt));
    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null });
  });

  it('preserves a scheduled wake that completes during sleep confirmation', async () => {
    const wakeAt = new Date(NOW.getTime() + MINUTE);
    const id = await seedMachine({ overrides: { nextWakeAt: wakeAt } });
    const { sleeper: s, isSuspended, ensureRunning } = sleeper({ lifecycle: { ok: false, code: 'asleep' } });
    isSuspended.mockImplementationOnce(async () => {
      // The host's suspended observation arrives after the wake lane committed.
      await s.wakeTick(wakeAt);
      return true;
    });

    await s.sleepTick(NOW);

    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null, awakeSince: wakeAt.toISOString() });
  });

  it('stops starting sleep candidates once the pass budget is spent', async () => {
    await seedMachine();
    await seedMachine();
    await seedMachine();
    let clock = 0;
    const { sleeper: s, readLifecycle } = sleeper({
      elapsedMs: () => clock,
      lifecycle: async () => { clock += SLEEP_PASS_BUDGET_MS + 1; return { ok: true, status: { ...IDLE, busy: true, busyReasons: ['chat_run'] } }; },
    });

    await s.tick(NOW);

    expect(SLEEP_PASS_BUDGET_MS).toBe(30_000);
    expect(readLifecycle).toHaveBeenCalledTimes(1);
  });

  it('still wakes a VM put to sleep while free after its owner moves to a paid plan', async () => {
    const id = await seedMachine({ paid: true, overrides: { status: 'suspended', nextWakeAt: ago(MINUTE) } });
    const { sleeper: s, ensureRunning } = sleeper();

    await s.tick(NOW);

    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null });
  });

  it('owner activity that arrives while the suspend runs cancels it and resumes the VM', async () => {
    const id = await seedMachine();
    const { sleeper: s, stop, ensureRunning } = sleeper();
    stop.mockImplementationOnce(async () => {
      // An owner request reaches the VM after the sleep claim, before the host suspends it.
      await db.executor.updateTable('user_machines').set({ last_activity_at: NOW }).where('machine_id', '=', id).execute();
      return { state: 'stopping' };
    });

    await s.tick(NOW);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null });
    expect(logs).toContainEqual({ event: 'sleep_cancelled_activity', fields: { machineId: id } });
  });

  it.each([false, true])('keeps a scheduled wake that wins during a suspend (lost reply: %s)', async (loseReply) => {
    const id = await seedMachine();
    const wakeAt = new Date(NOW.getTime() + MINUTE);
    const nextScheduledAt = new Date(wakeAt.getTime() + SCHEDULED_WAKE_LEAD_MS).toISOString();
    let clock = 0;
    let asleep = false;
    let finishStop!: () => void;
    const suspended = new Promise<void>((resolve) => { finishStop = resolve; });
    const { sleeper: s, stop, ensureRunning } = sleeper({
      elapsedMs: () => clock, lifecycle: { ok: true, status: { ...IDLE, nextScheduledAt } },
    });
    stop.mockImplementationOnce(async () => {
      await suspended;
      asleep = true;
      if (loseReply) throw new DOMException('timed out', 'TimeoutError');
      return { state: 'stopping' };
    });
    ensureRunning.mockImplementation(async () => { asleep = false; return { state: 'running' }; });

    const sleeping = s.sleepTick(NOW);
    try {
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      clock = MINUTE;
      await s.wakeTick(wakeAt);
      expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null });
    } finally {
      finishStop();
      await sleeping;
    }
    expect(ensureRunning).toHaveBeenCalledTimes(2);
    expect(asleep).toBe(false);
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: loseReply ? wakeAt.toISOString() : null });
  });

  it('a cancelled suspend keeps the saved wake until the resume is confirmed', async () => {
    const scheduledAt = new Date(NOW.getTime() + HOUR);
    const id = await seedMachine();
    const { sleeper: s, stop, ensureRunning } = sleeper({
      lifecycle: { ok: true, status: { ...IDLE, nextScheduledAt: scheduledAt.toISOString() } },
    });
    stop.mockImplementationOnce(async () => {
      await db.executor.updateTable('user_machines').set({ last_activity_at: NOW }).where('machine_id', '=', id).execute();
      return { state: 'stopping' };
    });
    ensureRunning.mockResolvedValueOnce({ state: 'failed', code: 'provider_unavailable' });

    await s.tick(NOW);

    const wakeAt = new Date(scheduledAt.getTime() - SCHEDULED_WAKE_LEAD_MS).toISOString();
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: wakeAt });
  });

  it('runs due scheduled wakes in parallel, so one slow VM does not hold up the others', async () => {
    for (let index = 0; index < 3; index += 1) {
      await seedMachine({ overrides: { status: 'suspended', nextWakeAt: ago(MINUTE) } });
    }
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { sleeper: s, ensureRunning } = sleeper();
    ensureRunning.mockImplementation(async () => { started += 1; await gate; return { state: 'running' }; });

    const tick = s.tick(NOW);
    await vi.waitFor(() => expect(started).toBe(3), { timeout: 1_000 });
    release();
    await tick;
  });

  it('starts every due scheduled wake of a tick at once, so slow VMs cannot queue the rest', async () => {
    for (let index = 0; index < 8; index += 1) {
      await seedMachine({ overrides: { status: 'suspended', nextWakeAt: ago(MINUTE) } });
    }
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { sleeper: s, ensureRunning } = sleeper();
    ensureRunning.mockImplementation(async () => { started += 1; await gate; return { state: 'running' }; });

    const tick = s.tick(NOW);
    await vi.waitFor(() => expect(started).toBe(8), { timeout: 1_000 });
    release();
    await tick;
  });

  it('counts the wake phase against the pass budget, so the pass ends before the next tick', async () => {
    await seedMachine({ overrides: { status: 'suspended', nextWakeAt: ago(MINUTE) } });
    await seedMachine();
    let clock = 0;
    const { sleeper: s, ensureRunning, readLifecycle } = sleeper({ elapsedMs: () => clock });
    ensureRunning.mockImplementation(async () => { clock += SLEEP_PASS_BUDGET_MS; return { state: 'running' }; });

    await s.tick(NOW);

    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(readLifecycle).not.toHaveBeenCalled();
  });

  it('stops waiting for a stalled suspend, keeping the saved wake', async () => {
    const scheduledAt = new Date(NOW.getTime() + HOUR);
    const id = await seedMachine();
    const { sleeper: s, stop } = sleeper({
      suspendWaitMs: 20,
      lifecycle: { ok: true, status: { ...IDLE, nextScheduledAt: scheduledAt.toISOString() } },
    });
    stop.mockImplementationOnce(async (_ref, signal: AbortSignal) => new Promise<StopRuntimeResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

    await s.tick(NOW);

    const wakeAt = new Date(scheduledAt.getTime() - SCHEDULED_WAKE_LEAD_MS).toISOString();
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: wakeAt });
    expect(logs).toContainEqual({ event: 'sleep_suspend_failed', fields: { machineId: id, code: 'TimeoutError' } });
  });

  it('decides on the current time, not the tick start, when the next job is close', async () => {
    const id = await seedMachine();
    // The wake phase took 2 minutes; the next job is 2.5 minutes after the tick started.
    let clock = 0;
    const { sleeper: s, stop } = sleeper({
      elapsedMs: () => clock,
      lifecycle: async () => {
        clock += 2 * MINUTE;
        return { ok: true, status: { ...IDLE, nextScheduledAt: new Date(NOW.getTime() + 2.5 * MINUTE).toISOString() } };
      },
    });

    await s.tick(NOW);

    expect(stop).not.toHaveBeenCalled();
    expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null });
  });

  it('never sleeps a free-plan owner whose active operator override grants a paid plan', async () => {
    const id = await seedMachine();
    const owner = (await machine(id)).clerkUserId;
    await db.executor.insertInto('billing_entitlement_overrides').values({ id: 'override_paid', clerk_user_id: owner,
      plan_slug: 'internal', status: 'active', max_runtime_slots: 1, included_runtime_slots: 1, addon_runtime_slots: 0,
      default_server_type: 'cpx22', allowed_server_types: '["cpx22"]', reason: 'support', created_by: 'operator',
      expires_at: null, revoked_at: null, created_at: ago(HOUR) }).execute();
    const { sleeper: s, stop } = sleeper();

    await s.tick(NOW);

    expect(stop).not.toHaveBeenCalled();
    expect(await machine(id)).toMatchObject({ status: 'running' });
  });

  it('concurrent ticks share one pass', async () => {
    await seedMachine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { sleeper: s, readLifecycle, stop } = sleeper({
      lifecycle: async () => { await gate; return { ok: true, status: IDLE }; },
    });

    const first = s.tick(NOW);
    const second = s.tick(NOW);
    release();
    await Promise.all([first, second]);

    expect(readLifecycle).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('warns once an hour when the lifecycle has been unavailable or incomplete for 6 hours', async () => {
    const id = await seedMachine({ overrides: { lastActivityAt: ago(2 * HOUR) } });
    let answer: LifecycleRead = { ok: false, code: 'unavailable' };
    const { sleeper: s } = sleeper({ lifecycle: async () => answer });
    const alerts = () => logs.filter((entry) => entry.event === 'lifecycle_unavailable_alert');

    await s.tick(NOW);
    answer = { ok: true, status: { ...IDLE, scheduleComplete: false } };
    await s.tick(new Date(NOW.getTime() + 3 * HOUR));
    expect(alerts()).toHaveLength(0);

    await s.tick(new Date(NOW.getTime() + LIFECYCLE_ALERT_AFTER_MS));
    expect(alerts()).toEqual([{ event: 'lifecycle_unavailable_alert', fields: { machineId: id, code: 'schedule_incomplete', hours: 6 } }]);

    await s.tick(new Date(NOW.getTime() + LIFECYCLE_ALERT_AFTER_MS + 30 * MINUTE));
    expect(alerts()).toHaveLength(1);
    await s.tick(new Date(NOW.getTime() + LIFECYCLE_ALERT_AFTER_MS + HOUR));
    expect(alerts()).toHaveLength(2);

    // A complete answer resets the clock.
    answer = { ok: true, status: { ...IDLE, busy: true, busyReasons: ['chat_run'] } };
    await s.tick(new Date(NOW.getTime() + LIFECYCLE_ALERT_AFTER_MS + 2 * HOUR));
    answer = { ok: false, code: 'timeout' };
    await s.tick(new Date(NOW.getTime() + LIFECYCLE_ALERT_AFTER_MS + 3 * HOUR));
    expect(alerts()).toHaveLength(2);
  });

  describe('against hostd', () => {
    let hostd: FakeHostd;

    beforeAll(async () => {
      hostd = await startFakeHostd();
    });

    afterAll(async () => {
      await hostd.close();
    });

    it('keeps the row running when hostd accepts a suspend but the snapshot fails', async () => {
      const id = await seedMachine();
      let readsAfterAcceptance = 0;
      let accepted = false;
      hostd.handle((req, res) => {
        if (req.method === 'POST') {
          accepted = true;
          return json(res, 202, { state: 'suspending' });
        }
        const state = accepted && readsAfterAcceptance++ === 0 ? 'suspending' : 'running';
        return json(res, 200, {
          id: VM_ID, machineId: id, generation: GENERATION, handle: 'owner1', tier: 'free', state,
          privateIPv4: '10.77.0.5', bootMiB: 2048, maxMiB: 8192, diskGiB: 20, chVersion: 'v48.0', snapshot: null,
          updatedAt: NOW.toISOString(),
        });
      });
      const repo = createMetalHostsRepository(db.kysely);
      await repo.upsert({
        id: 'host-a', name: 'host-a', apiUrl: hostd.origin, ingressHost: 'host-a.metal.example.test',
        status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
      });
      const substrate = createMetalSubstrate({
        loadMachine: (machineId) => getUserMachine(db, machineId), hosts: createMetalHostDirectory(repo),
        apiToken: 'a'.repeat(40), ingressToken: 'b'.repeat(40), caPem: hostd.caPem, log: () => {},
      });
      const s = createMetalSleeper({
        db, substrate, log: () => {}, suspendWaitMs: 1_000,
        readLifecycle: async () => ({ ok: true, status: IDLE }),
      });

      await s.sleepTick(NOW);

      expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null });
      expect(readsAfterAcceptance).toBeGreaterThanOrEqual(2);
    });

    it('sends expectedGeneration on suspend', async () => {
      const id = await seedMachine();
      const scheduledAt = new Date(NOW.getTime() + HOUR);
      hostd.requests.length = 0;
      let hostState = 'running';
      hostd.handle((req, res) => {
        if (req.method === 'GET' && req.path === `/v1/vms/${VM_ID}`) {
          json(res, 200, {
            id: VM_ID, machineId: id, generation: GENERATION, handle: 'owner1', tier: 'free', state: hostState,
            privateIPv4: '10.77.0.5', bootMiB: 2048, maxMiB: 8192, diskGiB: 20, chVersion: 'v48.0', snapshot: null,
            updatedAt: '2026-11-21T10:00:00.000Z',
          });
          return;
        }
        if (req.method === 'POST' && req.path === `/v1/vms/${VM_ID}/suspend`) {
          hostState = 'suspended';
          return json(res, 202, { state: 'suspending' });
        }
        if (req.method === 'POST' && req.path === `/v1/vms/${VM_ID}/resume`) return json(res, 200, { state: 'running' });
        json(res, 404, { error: 'not_found' });
      });
      const repo = createMetalHostsRepository(db.kysely);
      await repo.upsert({
        id: 'host-a', name: 'host-a', apiUrl: hostd.origin, ingressHost: 'host-a.metal.example.test',
        status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
      });
      const substrate = createMetalSubstrate({
        loadMachine: (machineId) => getUserMachine(db, machineId),
        hosts: createMetalHostDirectory(repo),
        apiToken: 'a'.repeat(40),
        ingressToken: 'b'.repeat(40),
        caPem: hostd.caPem,
        log: () => {},
      }) as OnDemandRuntimeSubstrate;
      const s = createMetalSleeper({
        db, substrate, log: () => {},
        readLifecycle: async () => ({ ok: true, status: { ...IDLE, nextScheduledAt: scheduledAt.toISOString() } }),
      });

      await s.tick(NOW);
      const suspend = hostd.requests.find((req) => req.path.endsWith('/suspend'));
      expect(suspend && JSON.parse(suspend.body)).toEqual({ expectedGeneration: GENERATION });
      expect(await machine(id)).toMatchObject({ status: 'suspended' });

      await s.tick(new Date(scheduledAt.getTime() - SCHEDULED_WAKE_LEAD_MS));
      const resume = hostd.requests.find((req) => req.path.endsWith('/resume'));
      expect(resume && JSON.parse(resume.body)).toMatchObject({ expectedGeneration: GENERATION });
      expect(await machine(id)).toMatchObject({ status: 'running' });
    });

    it('a generation conflict from hostd leaves the VM running', async () => {
      const id = await seedMachine();
      hostd.handle((req, res) => {
        if (req.method === 'GET') {
          json(res, 200, {
            id: VM_ID, machineId: id, generation: GENERATION, handle: 'owner1', tier: 'free', state: 'running',
            privateIPv4: '10.77.0.5', bootMiB: 2048, maxMiB: 8192, diskGiB: 20, chVersion: 'v48.0', snapshot: null,
            updatedAt: '2026-11-21T10:00:00.000Z',
          });
          return;
        }
        json(res, 409, { error: 'conflict' });
      });
      const repo = createMetalHostsRepository(db.kysely);
      await repo.upsert({
        id: 'host-a', name: 'host-a', apiUrl: hostd.origin, ingressHost: 'host-a.metal.example.test',
        status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
      });
      const substrate = createMetalSubstrate({
        loadMachine: (machineId) => getUserMachine(db, machineId), hosts: createMetalHostDirectory(repo),
        apiToken: 'a'.repeat(40), ingressToken: 'b'.repeat(40), caPem: hostd.caPem, log: () => {},
      }) as OnDemandRuntimeSubstrate;
      const s = createMetalSleeper({ db, substrate, log: () => {}, readLifecycle: async () => ({ ok: true, status: IDLE }) });

      await s.tick(NOW);

      expect(await machine(id)).toMatchObject({ status: 'running', nextWakeAt: null });
    });
  });
});

describe('metal sleeper worker', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('ticks now and every 60 s, single flight, and stop aborts and drains the tick in flight', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const tick = vi.fn((_now: Date, signal: AbortSignal) => {
      signals.push(signal);
      if (tick.mock.calls.length === 2) {
        return new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return Promise.resolve();
    });
    const worker = startMetalSleeperWorker({ sleeper: { tick }, log: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(METAL_SLEEP_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    // Still running: the next interval is skipped.
    await vi.advanceTimersByTimeAsync(METAL_SLEEP_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);

    worker.stop();
    expect(signals[1]?.aborted).toBe(true);
    await worker.drain();
    await vi.advanceTimersByTimeAsync(5 * METAL_SLEEP_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    release();
  });

  it('keeps scanning scheduled wakes while the idle sleep worker is still in flight', async () => {
    vi.useFakeTimers();
    const sleep = vi.fn((_now: Date, signal: AbortSignal) => new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    }));
    const wake = vi.fn(async () => {});
    const worker = startMetalSleeperWorker({ sleeper: { tick: sleep }, scheduledWake: { tick: wake }, log: () => {} });
    try {
      await vi.advanceTimersByTimeAsync(METAL_SLEEP_INTERVAL_MS);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledTimes(1 + METAL_SLEEP_INTERVAL_MS / METAL_WAKE_INTERVAL_MS);
    } finally {
      worker.stop();
      await worker.drain();
    }
  });

  it('starts the next scheduled wake scan promptly after a saturated pass', async () => {
    vi.useFakeTimers();
    const wake = vi.fn(async () => {});
    wake.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 32_000));
    });
    const worker = startMetalSleeperWorker({ sleeper: { tick: vi.fn(async () => {}) }, scheduledWake: { tick: wake } });
    try {
      await vi.advanceTimersByTimeAsync(32_000);
      expect(wake).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(wake).toHaveBeenCalledTimes(2);
    } finally {
      worker.stop();
      await worker.drain();
    }
  });

  it('ticks only while holding the cluster-wide singleton', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {});
    let held = true; // another worker instance holds the sleeper lock
    const singleton = vi.fn(async (run: () => Promise<void>) => { if (!held) await run(); });
    const worker = startMetalSleeperWorker({ sleeper: { tick }, singleton, log: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(singleton).toHaveBeenCalledTimes(1);
    expect(tick).not.toHaveBeenCalled();
    held = false;
    await vi.advanceTimersByTimeAsync(METAL_SLEEP_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(1);
    worker.stop();
    await worker.drain();
  });

  it('logs a failed tick by error name and keeps ticking', async () => {
    vi.useFakeTimers();
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const tick = vi.fn(async () => { throw new TypeError('connection to 10.0.0.5 refused'); });
    const worker = startMetalSleeperWorker({ sleeper: { tick }, log: (event, fields) => { logs.push({ event, fields }); } });
    await vi.advanceTimersByTimeAsync(METAL_SLEEP_INTERVAL_MS);
    worker.stop();
    await worker.drain();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(logs[0]).toEqual({ event: 'sleeper_tick_failed', fields: { code: 'TypeError' } });
  });
});

describe('lifecycle reader', () => {
  let server: FakeHostd;
  const cert = generateSelfSignedCert();
  const PLATFORM_SECRET = 's'.repeat(40);
  const INGRESS_TOKEN = 'ingress-'.padEnd(40, 'y');
  const machine = { machineId: 'm-1', handle: 'alice', status: 'running', substrate: 'metal', metalHostId: 'host-a' } as UserMachineRecord;

  beforeAll(async () => {
    server = await startFakeHostd(cert);
  });

  afterAll(async () => {
    await server.close();
  });

  function reader(timeoutMs?: number) {
    const upstream = (): RuntimeUpstream => ({
      url: `${server.origin}/api/system/lifecycle`,
      hostHeader: 'app.matrix-os.com',
      tlsServerName: '127.0.0.1',
      headers: { [HOST_AUTH_HEADER]: INGRESS_TOKEN },
      extraCaPem: cert.cert,
    });
    const substrates = createSubstrateRegistry([{
      kind: 'metal', startsOnDemand: true,
      resolveUpstream: (m, target) => (m.status === 'running' ? { ...upstream(), url: `${server.origin}${target.path}` } : null),
      ensureRunning: async () => ({ state: 'running' }),
    }]);
    return createLifecycleReader({ substrates, platformSecret: PLATFORM_SECRET, ...(timeoutMs ? { timeoutMs } : {}) });
  }

  it('reads the lifecycle through the host ingress with the platform runtime credential', async () => {
    server.requests.length = 0;
    const status = { ...IDLE, nextScheduledAt: '2026-11-21T13:00:00.000Z' };
    server.handle((_req, res) => json(res, 200, status));

    await expect(reader()(machine, new AbortController().signal)).resolves.toEqual({ ok: true, status });

    const req = server.requests[0];
    expect(req).toMatchObject({ method: 'GET', path: '/api/system/lifecycle' });
    expect(req?.headers.host).toBe('app.matrix-os.com');
    expect(req?.headers.authorization).toBe(`Bearer ${buildPlatformVerificationToken('alice', PLATFORM_SECRET)}`);
    expect(req?.headers[HOST_AUTH_HEADER]).toBe(INGRESS_TOKEN);
  });

  it('answers unavailable on a 503 lifecycle_unavailable and other non-2xx answers', async () => {
    server.handle((_req, res) => json(res, 503, { error: 'lifecycle_unavailable' }));
    await expect(reader()(machine, new AbortController().signal)).resolves.toEqual({ ok: false, code: 'unavailable' });
    server.handle((_req, res) => json(res, 401, { error: 'unauthorized' }));
    await expect(reader()(machine, new AbortController().signal)).resolves.toEqual({ ok: false, code: 'unavailable' });
  });

  it('answers asleep only for the ingress-marked runtime_asleep answer', async () => {
    server.handle((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json', 'x-matrix-ingress-error': 'runtime_asleep' });
      res.end(JSON.stringify({ error: 'runtime_asleep' }));
    });
    await expect(reader()(machine, new AbortController().signal)).resolves.toEqual({ ok: false, code: 'asleep' });
    // The same body from the VM itself, without the ingress marker, is just unavailable.
    server.handle((_req, res) => json(res, 503, { error: 'runtime_asleep' }));
    await expect(reader()(machine, new AbortController().signal)).resolves.toEqual({ ok: false, code: 'unavailable' });
  });

  it('answers invalid_response for a body that fails the contract', async () => {
    server.handle((_req, res) => json(res, 200, { busy: true, busyReasons: [], nextScheduledAt: null, scheduleComplete: true }));
    await expect(reader()(machine, new AbortController().signal)).resolves.toEqual({ ok: false, code: 'invalid_response' });
    server.handle((_req, res) => json(res, 200, { ...IDLE, padding: 'x'.repeat(8 * 1024) }));
    await expect(reader()(machine, new AbortController().signal)).resolves.toEqual({ ok: false, code: 'invalid_response' });
  });

  it('answers timeout when the gateway does not answer in time', async () => {
    server.handle(() => { /* never answers */ });
    await expect(reader(100)(machine, new AbortController().signal)).resolves.toEqual({ ok: false, code: 'timeout' });
  });

  it('answers not_routable for a runtime with no upstream', async () => {
    await expect(reader()({ ...machine, status: 'suspended' }, new AbortController().signal))
      .resolves.toEqual({ ok: false, code: 'not_routable' });
  });
});
