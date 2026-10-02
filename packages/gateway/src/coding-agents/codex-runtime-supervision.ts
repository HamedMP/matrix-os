import { boundedOperation } from "../bounded-operation.js";

export interface RuntimeSupervision {
  startedAt: number;
  nextProbeAt: number;
  failures: number;
  ready: boolean;
  observedAlive?: boolean;
  terminal: boolean;
  /** Start time of the most recent probe; activity after it proves the runtime is working. */
  lastProbeAt?: number;
}

/**
 * Supervise outside the runner: its own watchdog cannot detect its death.
 * `working` is bridge-observed evidence since the previous probe (output ingested, or the
 * runtime is blocked on a gateway-executed canonical action). An unanswered probe is unknown,
 * not dead: only a silent runtime with repeated unknowns ends the run.
 */
export async function runtimeUnavailable(
  state: RuntimeSupervision,
  probe: () => Promise<boolean>,
  now: number,
  working = false,
): Promise<boolean> {
  if (state.terminal || now < state.nextProbeAt) return false;
  state.nextProbeAt = now + 10_000;
  state.lastProbeAt = now;
  try {
    const alive = await boundedOperation(probe, 5_000);
    state.failures = 0;
    const startupExpired = now - state.startedAt >= 60_000;
    if (alive) state.observedAlive = true;
    return (!alive && (state.observedAlive === true || state.ready || startupExpired))
      || (!state.ready && startupExpired);
  } catch (error: unknown) {
    state.failures = working ? 0 : state.failures + 1;
    console.warn("[coding-agents] Runtime liveness unavailable", {
      errorType: error instanceof Error ? error.name : "UnknownError", attempt: state.failures, working,
    });
    // Unknown is not immediately dead, but a silent runtime must not leave Working indefinitely.
    return state.failures >= 3;
  }
}
