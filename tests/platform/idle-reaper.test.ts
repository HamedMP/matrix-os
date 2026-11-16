import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserMachine, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import type { ContainerProvider } from '../../packages/platform/src/substrates/container-provider.js';
import type { ContainerRuntimeClient, RuntimeFlushOutcome, RuntimeQuiesceOutcome } from '../../packages/platform/src/substrates/container-runtime-client.js';
import {
  createActivityTracker,
  createIdleReaper,
  isMeaningfulOwnerRequest,
} from '../../packages/platform/src/substrates/idle-reaper.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const T0 = new Date('2026-11-12T09:00:00.000Z');
const MINUTE = 60_000;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const HOST = 'mvm-1.lambda-microvm.eu-west-1.on.aws';

function fakeProvider(overrides: Partial<ContainerProvider> = {}): ContainerProvider {
  return {
    run: vi.fn(async () => { throw new Error('unused'); }),
    suspend: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    describe: vi.fn(async () => null),
    list: vi.fn(async () => []),
    mintEndpointCredential: vi.fn(async () => ({ headers: {}, expiresAt: T0 })),
    ...overrides,
  };
}

function fakeRuntime(script: {
  quiesce?: RuntimeQuiesceOutcome[];
  flush?: RuntimeFlushOutcome[];
} = {}) {
  const calls: string[] = [];
  const quiesce = [...(script.quiesce ?? [{ ok: true, unsettledRuns: 0 }])];
  const flush = [...(script.flush ?? [{ ok: true, manifestDigest: DIGEST }])];
  const client: ContainerRuntimeClient = {
    quiesce: vi.fn(async () => { calls.push('quiesce'); return quiesce.length > 1 ? quiesce.shift()! : quiesce[0]!; }),
    resume: vi.fn(async () => { calls.push('resume'); return true; }),
    flush: vi.fn(async () => { calls.push('flush'); return flush.length > 1 ? flush.shift()! : flush[0]!; }),
  };
  return { client, calls };
}

describe('meaningful owner activity', () => {
  const request = (method: string, path: string, headers: Record<string, string> = {}) => ({
    method, path, header: (name: string) => headers[name.toLowerCase()],
  });

  it('counts accepted work and opening the runtime, not background traffic', () => {
    expect(isMeaningfulOwnerRequest(request('POST', '/api/message'))).toBe(true);
    expect(isMeaningfulOwnerRequest(request('POST', '/api/bridge/db/query'))).toBe(true);
    expect(isMeaningfulOwnerRequest(request('GET', '/', { 'sec-fetch-mode': 'navigate' }))).toBe(true);
    expect(isMeaningfulOwnerRequest(request('GET', '/apps/notes/', { 'sec-fetch-dest': 'iframe' }))).toBe(true);

    expect(isMeaningfulOwnerRequest(request('GET', '/api/conversations'))).toBe(false);
    expect(isMeaningfulOwnerRequest(request('GET', '/api/system/info', { 'sec-fetch-mode': 'cors' }))).toBe(false);
    expect(isMeaningfulOwnerRequest(request('POST', '/api/presence'))).toBe(false);
    expect(isMeaningfulOwnerRequest(request('POST', '/api/session/heartbeat'))).toBe(false);
    expect(isMeaningfulOwnerRequest(request('POST', '/api/client-errors'))).toBe(false);
    expect(isMeaningfulOwnerRequest(request('GET', '/ws/terminal/tab', { upgrade: 'websocket' }))).toBe(false);
    expect(isMeaningfulOwnerRequest(request('OPTIONS', '/api/message'))).toBe(false);
  });
});

describe('container idle stop', () => {
  let db: PlatformDB;
  let clock: Date;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock = new Date(T0);
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: 'user_idle_a', handle: 'idle-alice', status: 'running',
      provisionedAt: '2026-11-01T00:00:00.000Z', substrate: 'container', generation: 3,
    });
    await db.executor.updateTable('user_machines').set({
      substrate_ref: 'mvm-1', private_address: HOST, started_at: T0, last_activity_at: T0, status_changed_at: T0,
    }).where('machine_id', '=', 'ctr-1').execute();
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  const row = async () => (await getUserMachine(db, 'ctr-1'))!;
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

  function setup(options: {
    provider?: ContainerProvider;
    runtime?: ReturnType<typeof fakeRuntime>;
    config?: Parameters<typeof createIdleReaper>[0]['config'];
    onSleep?: () => void | Promise<void>;
  } = {}) {
    const provider = options.provider ?? fakeProvider();
    const runtime = options.runtime ?? fakeRuntime();
    const now = () => new Date(clock);
    const lifecycle = createContainerLifecycleService({
      db, provider, now, logError: () => undefined, buildBootPayload: async () => '{}',
    });
    const activity = createActivityTracker({ db, now, logError: () => undefined });
    const reaper = createIdleReaper({
      db, lifecycle, runtime: runtime.client, activity, now,
      logError: () => undefined,
      config: options.config,
      sleep: async (ms, signal) => {
        signal.throwIfAborted();
        advance(ms);
        await options.onSleep?.();
      },
    });
    return { provider, runtime, lifecycle, activity, reaper };
  }

  describe('activity tracker', () => {
    it('persists owner activity once per flush, not once per request', async () => {
      const { activity } = setup();
      advance(5 * MINUTE);
      for (let i = 0; i < 50; i += 1) activity.observe('ctr-1');
      expect((await row()).lastActivityAt).toBe(T0.toISOString());
      await activity.flush();
      expect((await row()).lastActivityAt).toBe(new Date(T0.getTime() + 5 * MINUTE).toISOString());
      expect(activity.size).toBe(0);
    });

    it('never moves the recorded activity backwards when another instance saw a later request', async () => {
      const { activity } = setup();
      advance(MINUTE);
      activity.observe('ctr-1');
      await db.executor.updateTable('user_machines')
        .set({ last_activity_at: new Date(T0.getTime() + 2 * MINUTE) }).where('machine_id', '=', 'ctr-1').execute();
      await activity.flush();
      expect((await row()).lastActivityAt).toBe(new Date(T0.getTime() + 2 * MINUTE).toISOString());
    });

    it('is bounded and evicts the least recently active runtime first', () => {
      const tracker = createActivityTracker({ db, now: () => new Date(clock), maxEntries: 2, logError: () => undefined });
      tracker.observe('a');
      tracker.observe('b');
      tracker.observe('a');
      tracker.observe('c');
      expect(tracker.size).toBe(2);
      expect(tracker.lastObserved('b')).toBeNull();
      expect(tracker.lastObserved('a')).not.toBeNull();
    });

    it('persists activity on its own interval, so a serving replica without sweeps still records it', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        const { activity } = setup();
        activity.startPeriodicFlush(30_000);
        expect(vi.getTimerCount()).toBe(1);
        advance(5 * MINUTE);
        activity.observe('ctr-1');
        vi.advanceTimersByTime(30_000);
        await vi.waitFor(async () => expect((await row()).lastActivityAt).toBe(new Date(T0.getTime() + 5 * MINUTE).toISOString()));
        activity.stopPeriodicFlush();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops observations older than its TTL', () => {
      const tracker = createActivityTracker({ db, now: () => new Date(clock), ttlMs: MINUTE, logError: () => undefined });
      tracker.observe('a');
      advance(2 * MINUTE);
      tracker.observe('b');
      expect(tracker.lastObserved('a')).toBeNull();
      expect(tracker.size).toBe(1);
    });
  });

  it('stops an idle runtime by quiescing, flushing, then suspending, and records the flush', async () => {
    const provider = fakeProvider();
    const { reaper, runtime } = setup({ provider });
    advance(11 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(runtime.calls).toEqual(['quiesce', 'flush']);
    expect(provider.suspend).toHaveBeenCalledWith('mvm-1', expect.any(AbortSignal));
    const machine = await row();
    expect(machine.status).toBe('stopped');
    const flush = await db.executor.selectFrom('user_machines')
      .select(['last_flush_digest', 'last_flushed_at']).where('machine_id', '=', 'ctr-1').executeTakeFirstOrThrow();
    expect(flush.last_flush_digest).toBe(DIGEST);
    expect(flush.last_flushed_at?.toISOString()).toBe(clock.toISOString());
    const target = vi.mocked(runtime.client.quiesce).mock.calls[0]?.[0];
    expect(target).toMatchObject({ machineId: 'ctr-1', handle: 'idle-alice', clerkUserId: 'user_idle_a', unitId: 'mvm-1', endpointHost: HOST });
  });

  it('keeps a runtime whose owner was active within the idle window, including activity not yet persisted', async () => {
    const { reaper, runtime, activity } = setup();
    advance(9 * MINUTE);
    activity.observe('ctr-1');
    advance(2 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(runtime.calls).toEqual([]);
    expect((await row()).status).toBe('running');
  });

  it('treats an unsettled funded run as activity, but not past the maximum session', async () => {
    const { reaper, runtime } = setup();
    await db.executor.insertInto('ai_runtime_credentials').values({
      token_id: 'tok_idle_1', token_hash: 'a'.repeat(64), owner_id: 'user_idle_a', machine_id: 'ctr-1', runtime_slot: 'primary',
      audience: 'matrix-funded-relay', scope: 'ai:invoke', issued_at: T0.toISOString(), expires_at: T0.toISOString(), revoked_at: null,
    }).execute();
    await db.executor.insertInto('ai_funded_usage_reservations').values({
      reservation_id: 'res_idle_1', request_id: 'req_idle_1', payload_hash: 'b'.repeat(64), authorization_response: '{}',
      settlement_response: null, finalization_mode: null, manual_review_evidence_ref: null, manual_review_actor: null,
      manual_reviewed_at: null, start_response: null, release_response: null, release_reason: null,
      token_id: 'tok_idle_1', owner_id: 'user_idle_a', machine_id: 'ctr-1', runtime_slot: 'primary', model_id: 'anthropic/claude-sonnet-5',
      reserved_microusd: 1, promotional_reserved_microusd: null, addon_reserved_microusd: null, actual_microusd: null,
      resolved_model: null, pricing_version: null, period_start: T0.toISOString(), status: 'in_flight',
      created_at: T0.toISOString(), started_at: null, expires_at: new Date(T0.getTime() + 24 * 60 * MINUTE).toISOString(),
      settled_at: null, released_at: null,
    }).execute();
    advance(30 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(runtime.calls).toEqual([]);

    advance(4 * 60 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(runtime.calls).toEqual(['quiesce', 'flush']);
    expect((await row()).status).toBe('stopped');
  });

  it('restarts the idle window when a run settles, so a reply is not cut off as it arrives', async () => {
    const { reaper, runtime } = setup();
    await db.executor.insertInto('ai_runtime_credentials').values({
      token_id: 'tok_idle_2', token_hash: 'c'.repeat(64), owner_id: 'user_idle_a', machine_id: 'ctr-1', runtime_slot: 'primary',
      audience: 'matrix-funded-relay', scope: 'ai:invoke', issued_at: T0.toISOString(), expires_at: T0.toISOString(), revoked_at: null,
    }).execute();
    // The owner's message at T0 started a run that settled 15 minutes later.
    await db.executor.insertInto('ai_funded_usage_reservations').values({
      reservation_id: 'res_idle_2', request_id: 'req_idle_2', payload_hash: 'd'.repeat(64), authorization_response: '{}',
      settlement_response: null, finalization_mode: null, manual_review_evidence_ref: null, manual_review_actor: null,
      manual_reviewed_at: null, start_response: null, release_response: null, release_reason: null,
      token_id: 'tok_idle_2', owner_id: 'user_idle_a', machine_id: 'ctr-1', runtime_slot: 'primary', model_id: 'anthropic/claude-sonnet-5',
      reserved_microusd: 1, promotional_reserved_microusd: null, addon_reserved_microusd: null, actual_microusd: null,
      resolved_model: null, pricing_version: null, period_start: T0.toISOString(), status: 'released',
      created_at: T0.toISOString(), started_at: null, expires_at: new Date(T0.getTime() + 24 * 60 * MINUTE).toISOString(),
      settled_at: null, released_at: new Date(T0.getTime() + 15 * MINUTE).toISOString(),
    }).execute();
    advance(16 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(runtime.calls).toEqual([]);
    expect((await row()).status).toBe('running');

    advance(10 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(runtime.calls).toEqual(['quiesce', 'flush']);
    expect((await row()).status).toBe('stopped');
  });

  it('stops at the maximum session even while the owner stays active', async () => {
    const { reaper, runtime, activity } = setup();
    advance(4 * 60 * MINUTE + MINUTE);
    activity.observe('ctr-1');
    await reaper.sweep();
    await reaper.drain();
    expect(runtime.calls).toEqual(['quiesce', 'flush']);
    expect((await row()).status).toBe('stopped');
  });

  it('waits for unsettled runs to settle before flushing', async () => {
    const runtime = fakeRuntime({ quiesce: [{ ok: true, unsettledRuns: 2 }, { ok: true, unsettledRuns: 1 }, { ok: true, unsettledRuns: 0 }] });
    const { reaper } = setup({ runtime });
    advance(11 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(runtime.calls).toEqual(['quiesce', 'quiesce', 'quiesce', 'flush']);
    expect((await row()).status).toBe('stopped');
  });

  it('flushes once runs reach the quiesce deadline instead of waiting forever', async () => {
    const runtime = fakeRuntime({ quiesce: [{ ok: true, unsettledRuns: 1 }] });
    const { reaper } = setup({ runtime, config: { quiesceDeadlineMs: 2 * MINUTE, pollIntervalMs: MINUTE } });
    advance(11 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(runtime.calls.filter(call => call === 'flush')).toHaveLength(1);
    expect((await row()).status).toBe('stopped');
  });

  it('marks needs_recovery after bounded flush retries, keeps the disk, and never stops silently', async () => {
    const runtime = fakeRuntime({ flush: [{ ok: false, error: 'flush_failed' }] });
    const provider = fakeProvider();
    const { reaper } = setup({ runtime, provider });
    advance(11 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(runtime.calls).toEqual(['quiesce', 'flush', 'flush', 'flush', 'resume']);
    expect(provider.suspend).toHaveBeenCalledWith('mvm-1', expect.any(AbortSignal));
    expect(provider.terminate).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: 'needs_recovery', failureCode: 'flush_failed', substrateRef: 'mvm-1' });
  });

  it('marks needs_recovery when the runtime never answers quiesce before the deadline', async () => {
    const runtime = fakeRuntime({ quiesce: [{ ok: false, error: 'unavailable' }] });
    const { reaper } = setup({ runtime, config: { quiesceDeadlineMs: 3 * MINUTE, pollIntervalMs: MINUTE } });
    advance(11 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(runtime.calls).not.toContain('flush');
    expect(await row()).toMatchObject({ status: 'needs_recovery', failureCode: 'quiesce_timeout' });
  });

  it('cancels an idle stop when the owner comes back during quiesce', async () => {
    const runtime = fakeRuntime({ quiesce: [{ ok: true, unsettledRuns: 1 }] });
    let tracker: ReturnType<typeof createActivityTracker> | undefined;
    const { reaper, activity } = setup({ runtime, onSleep: () => { tracker?.observe('ctr-1'); } });
    tracker = activity;
    advance(11 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(runtime.calls).toEqual(['quiesce', 'resume']);
    expect((await row()).status).toBe('running');
  });

  it('recovers a stop whose worker disappeared once the stop budget has passed', async () => {
    const provider = fakeProvider();
    const { reaper, runtime } = setup({ provider });
    // Another instance began the stop and crashed: the row stays quiescing with nobody driving it.
    await db.executor.updateTable('user_machines').set({ status: 'quiescing', status_changed_at: T0, last_activity_at: T0 })
      .where('machine_id', '=', 'ctr-1').execute();
    advance(10 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect((await row()).status).toBe('quiescing');
    expect(provider.suspend).not.toHaveBeenCalled();

    advance(13 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(provider.suspend).toHaveBeenCalledWith('mvm-1', expect.any(AbortSignal));
    expect(runtime.calls).toEqual([]);
    expect(await row()).toMatchObject({ status: 'needs_recovery', failureCode: 'quiesce_timeout', substrateRef: 'mvm-1', generation: 3 });
  });

  it('cancels an idle stop when the owner comes back during the first quiesce, even with no runs left', async () => {
    const runtime = fakeRuntime();
    let tracker: ReturnType<typeof createActivityTracker> | undefined;
    vi.mocked(runtime.client.quiesce).mockImplementation(async () => {
      runtime.calls.push('quiesce');
      advance(1_000);
      tracker?.observe('ctr-1');
      return { ok: true, unsettledRuns: 0 };
    });
    const { reaper, activity, provider } = setup({ runtime });
    tracker = activity;
    advance(11 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(runtime.calls).toEqual(['quiesce', 'resume']);
    expect(provider.suspend).not.toHaveBeenCalled();
    expect((await row()).status).toBe('running');
  });

  it('cancels an idle stop for owner activity recorded after the runtime was selected', async () => {
    const runtime = fakeRuntime();
    const { reaper, provider } = setup({ runtime });
    advance(11 * MINUTE);
    // Another instance records the owner's request between selection and the quiesce.
    let recorded = false;
    vi.mocked(runtime.client.quiesce).mockImplementation(async () => {
      runtime.calls.push('quiesce');
      if (!recorded) {
        recorded = true;
        await db.executor.updateTable('user_machines').set({ last_activity_at: new Date(clock.getTime() + 1) })
          .where('machine_id', '=', 'ctr-1').execute();
      }
      advance(1_000);
      return { ok: true, unsettledRuns: 0 };
    });
    await reaper.sweep();
    await reaper.drain();
    expect(provider.suspend).not.toHaveBeenCalled();
    expect((await row()).status).toBe('running');
  });

  it('runs one stop when two platform instances sweep the same runtime', async () => {
    const runtime = fakeRuntime();
    const a = setup({ runtime });
    const b = setup({ runtime });
    advance(11 * MINUTE);
    await Promise.all([a.reaper.sweep(), b.reaper.sweep()]);
    await Promise.all([a.reaper.drain(), b.reaper.drain()]);
    expect(runtime.calls).toEqual(['quiesce', 'flush']);
    expect((await row()).status).toBe('stopped');
  });

  it('leaves a newer generation alone when compute was replaced during the stop', async () => {
    const provider = fakeProvider();
    const runtime = fakeRuntime();
    vi.mocked(runtime.client.flush).mockImplementation(async () => {
      await db.executor.updateTable('user_machines').set({ generation: 4, status: 'running', substrate_ref: 'mvm-2' })
        .where('machine_id', '=', 'ctr-1').execute();
      return { ok: true, manifestDigest: DIGEST };
    });
    const { reaper } = setup({ provider, runtime });
    advance(11 * MINUTE);
    await reaper.sweep();
    await reaper.drain();
    expect(provider.suspend).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: 'running', generation: 4, substrateRef: 'mvm-2' });
  });

  it('cancels its in-flight stop on shutdown and clears its timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let release: (() => void) | undefined;
      const runtime = fakeRuntime({ quiesce: [{ ok: true, unsettledRuns: 1 }] });
      const provider = fakeProvider();
      const lifecycle = createContainerLifecycleService({ db, provider, now: () => new Date(clock), logError: () => undefined, buildBootPayload: async () => '{}' });
      const reaper = createIdleReaper({
        db, lifecycle, runtime: runtime.client, activity: createActivityTracker({ db, now: () => new Date(clock), logError: () => undefined }),
        now: () => new Date(clock), logError: () => undefined,
        sleep: (_ms, signal) => new Promise<void>((resolve, reject) => {
          release = resolve;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      });
      reaper.start();
      expect(vi.getTimerCount()).toBe(1);
      advance(11 * MINUTE);
      await reaper.sweep();
      await vi.waitFor(() => expect(release).toBeDefined());
      await reaper.shutdown();
      expect(vi.getTimerCount()).toBe(0);
      expect(runtime.calls).toEqual(['quiesce', 'resume']);
      expect((await row()).status).toBe('running');
      expect(provider.suspend).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
