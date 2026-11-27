import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLAG_DEFINITIONS_POLL_INTERVAL_MS,
  PLATFORM_FEATURE_FLAGS,
  createServerFeatureFlags,
  type ServerFeatureFlags,
} from '../../packages/platform/src/feature-flags/server-flags.js';
import { connectSleepFlag } from '../../packages/platform/src/substrates/metal-runtime.js';
import { METAL_SLEEP_INTERVAL_MS, startMetalSleeperWorker } from '../../packages/platform/src/substrates/metal-sleeper.js';

/**
 * `free-tier-sleep` reaching the idle sleeper (ENG-608). The flag poller and
 * the sleeper interval run on independent clocks; with only the interval, a
 * flag turned on just after a pass waited for the poll and then a whole
 * interval (89 s observed). Faults detected: a flag change waiting for the
 * next 60 s pass, flag changes stacking passes, and unchanged polls running
 * extra passes.
 */

const ENV = {
  POSTHOG_FEATURE_FLAGS_SECURE_API_KEY: 'phs_secure-test-key',
  POSTHOG_PROJECT_TOKEN: 'phc_project-token',
  POSTHOG_HOST: 'https://eu.i.posthog.com',
};

function sleepFlag(active: boolean) {
  return {
    id: 2, key: 'free-tier-sleep', active, ensure_experience_continuity: false,
    filters: { groups: [{ rollout_percentage: 100, properties: [] }] },
  };
}

function otherFlag(active: boolean) {
  return { ...sleepFlag(active), id: 3, key: 'free-tier-enabled' };
}

function poster(initial: unknown[]) {
  let flags = initial;
  const fetch = vi.fn(async () => new Response(JSON.stringify({ flags, group_type_mapping: {}, cohorts: {} }), { status: 200 }));
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls: fetch, set(next: unknown[]) { flags = next; } };
}

const SUBJECT = { distinctId: 'user_owner' };
let flags: ServerFeatureFlags | undefined;
let stopWorker: (() => void) | undefined;

beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-28T12:00:00.000Z') }); });
afterEach(async () => {
  stopWorker?.();
  stopWorker = undefined;
  await flags?.shutdown();
  flags = undefined;
  vi.useRealTimers();
});

/** Real flag poller and sleeper scheduler; the sleep pass records whether the flag was on when it ran. */
async function harness(initial: unknown[]) {
  const posthog = poster(initial);
  flags = createServerFeatureFlags({ env: ENV, fetch: posthog.fetch, log: () => {} });
  await vi.advanceTimersByTimeAsync(10);
  const passes: Array<{ at: number; sleepOn: boolean | undefined }> = [];
  const current = flags;
  const tick = vi.fn(async () => {
    passes.push({ at: Date.now(), sleepOn: await current.evaluate(PLATFORM_FEATURE_FLAGS.freeTierSleep, SUBJECT) });
  });
  const worker = connectSleepFlag(flags, startMetalSleeperWorker({ sleeper: { tick }, log: () => {} }));
  stopWorker = () => worker.stop();
  await vi.advanceTimersByTimeAsync(10);
  return { posthog, passes, tick, worker };
}

function firstPassWithSleepOn(passes: Array<{ at: number; sleepOn: boolean | undefined }>, after: number) {
  return passes.find((pass) => pass.at >= after && pass.sleepOn === true);
}

describe('free-tier-sleep latency', () => {
  it.each([
    ['just after a sleeper pass and just after a poll (worst case)', 50],
    ['just after a sleeper pass and just before a poll', FLAG_DEFINITIONS_POLL_INTERVAL_MS - 50],
  ])('a flag turned on %s reaches a sleep pass within 60 s', async (_label, offset) => {
    const { posthog, passes } = await harness([sleepFlag(false)]);
    expect(passes).toHaveLength(1);
    expect(passes[0]?.sleepOn).toBe(false);

    await vi.advanceTimersByTimeAsync(offset);
    const flippedAt = Date.now();
    posthog.set([sleepFlag(true)]);
    await vi.advanceTimersByTimeAsync(60_000);

    const reached = firstPassWithSleepOn(passes, flippedAt);
    expect(reached).toBeDefined();
    expect(reached!.at - flippedAt).toBeLessThan(60_000);
    // Bound: one poll plus the pass itself.
    expect(reached!.at - flippedAt).toBeLessThanOrEqual(FLAG_DEFINITIONS_POLL_INTERVAL_MS + 1_000);
  });

  it('unchanged polls, or changes to other flags, run no extra pass', async () => {
    const { posthog, tick } = await harness([sleepFlag(true), otherFlag(false)]);
    // The first load is a change from unknown, so it may run one pass beside the startup pass.
    await vi.advanceTimersByTimeAsync(1_000);
    const settled = tick.mock.calls.length;

    posthog.set([sleepFlag(true), otherFlag(true)]);
    await vi.advanceTimersByTimeAsync(METAL_SLEEP_INTERVAL_MS - 2_000);

    expect(posthog.calls.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(tick.mock.calls.length).toBe(settled);
  });

  it('flips while a pass is in flight queue one pass behind it, not one each', async () => {
    const posthog = poster([sleepFlag(false)]);
    flags = createServerFeatureFlags({ env: ENV, fetch: posthog.fetch, log: () => {} });
    let release!: () => void;
    const tick = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const worker = connectSleepFlag(flags, startMetalSleeperWorker({ sleeper: { tick }, log: () => {} }));
    stopWorker = () => worker.stop();
    await vi.advanceTimersByTimeAsync(10);
    const started = tick.mock.calls.length;

    for (let i = 0; i < 4; i += 1) {
      posthog.set([sleepFlag(i % 2 === 0)]);
      await vi.advanceTimersByTimeAsync(FLAG_DEFINITIONS_POLL_INTERVAL_MS);
    }
    worker.requestSleepPass();
    expect(tick.mock.calls.length).toBe(started);

    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick.mock.calls.length).toBe(started + 1);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick.mock.calls.length).toBe(started + 1);
  });
});
