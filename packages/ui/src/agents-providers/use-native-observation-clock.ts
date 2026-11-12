import { useEffect, useState } from "react";
import type { ProviderAccount } from "@matrix-os/contracts";
import { nativeClaudeAuthenticationExpiry } from "./legacy-claude-connection.js";

const MAX_CLOCK_SKEW_MS = 60_000;
export interface NativeObservationTime { now: number; observedAt: number; }
interface Anchor {
  stamp: string;
  observedAt: number;
  monotonicAt: number;
  trustedFloor: number;
  valid: boolean;
}
function observe(stamp: string, trustedFloor = -Infinity): Anchor {
  const observedAt = Date.parse(stamp);
  const valid = Number.isFinite(observedAt) && observedAt >= trustedFloor
    && Math.abs(observedAt - Date.now()) <= MAX_CLOCK_SKEW_MS;
  return { stamp, observedAt, monotonicAt: performance.now(),
    trustedFloor: valid ? observedAt : trustedFloor, valid };
}
function currentTime(anchor: Anchor): number {
  return anchor.valid ? anchor.observedAt + Math.max(0, performance.now() - anchor.monotonicAt) : NaN;
}

/** Native proof uses the bounded server clock, then monotonic elapsed time, never a wall-clock rollback. */
export function useNativeObservationClock(refreshedAt: string, accounts: readonly ProviderAccount[]): NativeObservationTime {
  const [saved, setSaved] = useState(() => observe(refreshedAt));
  const [revision, setRevision] = useState(0);
  const anchor = saved.stamp === refreshedAt ? saved : observe(refreshedAt, saved.trustedFloor);
  // Adjust only for a new snapshot stamp. Re-rendering/replaying the same stamp
  // cannot restart the proof's lifetime, and an older stamp cannot resurrect it.
  if (anchor !== saved) setSaved(anchor);
  const expiries = accounts.filter(account => Date.parse(account.lastCheckedAt ?? "") <= anchor.observedAt)
    .map(nativeClaudeAuthenticationExpiry).filter((value): value is string => value !== null).join("|");
  useEffect(() => {
    if (!anchor.valid) return;
    const now = currentTime(anchor);
    const next = expiries.split("|").map(Date.parse).filter(time => Number.isFinite(time) && time >= now).sort((a,b) => a-b)[0];
    if (next === undefined) return;
    const timer = setTimeout(() => setRevision(value => value + 1), Math.min(next - now + 1, 30_001));
    return () => clearTimeout(timer);
  }, [anchor, expiries, revision]);
  return { now: currentTime(anchor), observedAt: anchor.valid ? anchor.observedAt : NaN };
}
