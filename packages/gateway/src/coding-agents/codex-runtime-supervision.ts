import { boundedOperation } from "../bounded-operation.js";

export interface RuntimeSupervision {
  startedAt: number;
  nextProbeAt: number;
  failures: number;
  ready: boolean;
  observedAlive?: boolean;
  terminal: boolean;
}

/** Supervise outside the runner: its own watchdog cannot detect its death. */
export async function runtimeUnavailable(
  state: RuntimeSupervision,
  probe: () => Promise<boolean>,
  now: number,
): Promise<boolean> {
  if (state.terminal || now < state.nextProbeAt) return false;
  state.nextProbeAt = now + 10_000;
  try {
    const alive = await boundedOperation(probe, 5_000);
    state.failures = 0;
    const startupExpired = now - state.startedAt >= 60_000;
    if (alive) state.observedAlive = true;
    return (!alive && (state.observedAlive === true || state.ready || startupExpired))
      || (!state.ready && startupExpired);
  } catch (error: unknown) {
    state.failures += 1;
    console.warn("[coding-agents] Runtime liveness unavailable", {
      errorType: error instanceof Error ? error.name : "UnknownError", attempt: state.failures,
    });
    // Unknown is not immediately dead, but must not leave Working indefinitely.
    return state.failures >= 3;
  }
}
