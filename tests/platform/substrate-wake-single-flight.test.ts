import { describe, expect, it } from 'vitest';
import type { PlatformDB, UserMachineRecord } from '../../packages/platform/src/db.js';
import { WAKE_IN_FLIGHT_MAX, wakeOnDemandRuntime } from '../../packages/platform/src/substrates/substrate-wake.js';
import type { RuntimeSubstrate } from '../../packages/platform/src/substrates/types.js';

/**
 * Single-flight wake registry under a burst (spec 2691, ENG-520). Fault
 * detected: a full registry evicting a wake that is still running, so a later
 * request for that machine starts a second host start instead of joining it.
 */
describe('single-flight wake registry at its cap', () => {
  it('keeps every running wake shared and refuses new machines as busy while full', async () => {
    let starts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const substrate = {
      kind: 'metal', startsOnDemand: true, resolveUpstream: () => null,
      ensureRunning: async () => { starts += 1; await gate; return { state: 'starting' as const }; },
    } as unknown as RuntimeSubstrate;
    const db = {} as PlatformDB;
    const machine = (index: number) => ({
      machineId: `burst-${index}`, handle: `h${index}`, runtimeSlot: 'primary', generation: 1, status: 'suspended',
    }) as unknown as UserMachineRecord;
    const log = () => {};

    const first = Array.from({ length: WAKE_IN_FLIGHT_MAX }, (_, index) => wakeOnDemandRuntime(db, substrate, machine(index), { log }));
    expect(starts).toBe(WAKE_IN_FLIGHT_MAX);

    // A new machine past the cap is refused without a host start.
    const overflow = await wakeOnDemandRuntime(db, substrate, machine(WAKE_IN_FLIGHT_MAX), { log });
    expect(overflow.result).toEqual({ state: 'busy' });
    expect(starts).toBe(WAKE_IN_FLIGHT_MAX);

    // The oldest wake is still shared: a repeat request joins it.
    expect(wakeOnDemandRuntime(db, substrate, machine(0), { log })).toBe(first[0]);
    expect(starts).toBe(WAKE_IN_FLIGHT_MAX);

    release();
    await Promise.all(first);
    // Settled wakes free their slots.
    const after = wakeOnDemandRuntime(db, substrate, machine(WAKE_IN_FLIGHT_MAX), { log });
    expect(starts).toBe(WAKE_IN_FLIGHT_MAX + 1);
    await after;
  });
});
