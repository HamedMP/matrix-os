import type { OperatorProbeBeginInput } from '@matrix-os/contracts/funded-operator-probe';
import { probeWithSignal } from '../ai-funded-jev-probe.js';
import type { FundedModelProbeService } from '../ai-funded-model-probes.js';

// A returned grant can lead to 18s provider work and a 3s finalize. Allow for
// both control hops and scheduling. Expiry removes only a local drain waiter.
const GRANT_DRAIN_MS = 25_000;
export const MONETARY_PLATFORM_SHUTDOWN_MS = 40_000;

export function createOperatorGrantDrain() {
  const active = new Map<symbol, { identity: string; done: Promise<void>; finish: () => void }>();
  let accepting = true;
  function track(input: Pick<OperatorProbeBeginInput, 'probeId' | 'executionId'>, binding: string) {
    if (!accepting || active.size >= 128) throw new Error('Operator probe admission unavailable');
    const key = Symbol(), wait = Promise.withResolvers<void>();
    const timer = setTimeout(finish, GRANT_DRAIN_MS + 3000);
    timer.unref();
    function finish() { clearTimeout(timer); active.delete(key); wait.resolve(); }
    active.set(key, { identity: JSON.stringify([binding, input.probeId, input.executionId]), done: wait.promise, finish });
    return finish;
  }
  return {
    track,
    finalized(probeId: string, executionId: string, binding: string) {
      const identity = JSON.stringify([binding, probeId, executionId]);
      for (const entry of active.values()) if (entry.identity === identity) entry.finish();
    },
    async quiesce() {
      accepting = false;
      await Promise.all([...active.values()].map(entry => entry.done));
    },
    close() { accepting = false; for (const entry of active.values()) entry.finish(); },
  };
}
export function closePlatformProbeTransport(probes: FundedModelProbeService | undefined, closeHttp: () => void): void {
  if (!probes?.quiesce) { closeHttp(); return; }
  // Quiesce synchronously closes admissions before its first await. Keep the listener
  // available to the Relay's independent finalize callback during this bounded window.
  const drain = probes.quiesce();
  void probeWithSignal(() => drain, AbortSignal.timeout(MONETARY_PLATFORM_SHUTDOWN_MS - 10_000)).then(closeHttp, error => {
    console.error('[operator-probe] Shutdown drain failed', { errorName: error instanceof Error ? error.name : 'Unknown' });
    closeHttp();
  });
}
