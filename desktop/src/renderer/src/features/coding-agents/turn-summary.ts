import type { AgentThreadEvent } from "@matrix-os/contracts";

/**
 * "Worked for Xs" turn summaries, derived purely from the thread event list
 * already held in memory — no store or runtime involvement.
 *
 * A turn is the run of events following a `user.message`, up to (but excluding)
 * the next one. A turn is finished when a later user message closes it, or when
 * the thread leaves its running states; the still-open final turn of a running
 * thread keeps the live "Working…" row instead of a summary.
 */
export interface TurnSummary {
  /** Index into the thread event list of the finished turn's last event. */
  endOrder: number;
  /** Rendered label, e.g. "Worked for 5m 35s". */
  label: string;
}

/** Formats a positive duration: "12s" under a minute, "5m 35s" / "5m" above. */
export function formatTurnDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function deriveTurnSummaries(
  events: AgentThreadEvent[],
  threadRunning: boolean,
): TurnSummary[] {
  const summaries: TurnSummary[] = [];
  // Start index (into `events`) of the open turn's first event; -1 while no
  // user message has opened a turn yet.
  let turnStart = -1;

  const closeTurn = (endOrder: number) => {
    if (turnStart < 0 || endOrder < turnStart) return;
    const startMs = Date.parse(events[turnStart]!.occurredAt);
    const endMs = Date.parse(events[endOrder]!.occurredAt);
    turnStart = -1;
    // Missing/unparseable timestamps and zero-length turns (a single event)
    // produce no row rather than a misleading duration.
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return;
    summaries.push({ endOrder, label: `Worked for ${formatTurnDuration(endMs - startMs)}` });
  };

  for (const [index, event] of events.entries()) {
    if (event.type !== "user.message") continue;
    // A new user message closes the previous turn (if any) and opens the next.
    closeTurn(index - 1);
    turnStart = index + 1;
  }
  // The final turn is live while the thread runs; only a terminal thread
  // closes it (final assistant completion / status transition away from
  // running is already reflected in the caller's threadRunning flag).
  if (!threadRunning) closeTurn(events.length - 1);

  return summaries;
}
