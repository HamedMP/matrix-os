import { useEffect, useEffectEvent, useRef, useState } from "react";
import { retainTerminalAttention, terminalAttentionChanges, type TerminalAttention, type TerminalTabFacts } from "./attention.js";
import { scheduleCompletionExpiry } from "./attention-expiry.js";

const MAX_VISIBLE = 3;
// Alerts waiting for a free slot; bounded, most recent kept.
const MAX_PENDING = 32;
// Blocked and errored agents need the person; they are shown before completions.
const URGENT = (alert: TerminalAttention) => (alert.kind === "done" ? 1 : 0);

function sameAlerts(left: readonly TerminalAttention[], right: readonly TerminalAttention[]): boolean {
  return left.length === right.length
    && left.every((alert, index) => alert.key === right[index]!.key && alert.kind === right[index]!.kind
      && alert.name === right[index]!.name && alert.message === right[index]!.message);
}

/**
 * Attention toasts shared by every OS view: `facts` is the latest snapshot, or
 * null while nothing is known (the next snapshot is then a fresh baseline, never
 * a batch of news). `seen` lists the tabs on screen now. Done alerts expire a
 * while after they are first shown; blocked and errored ones stay until
 * dismissed or resolved.
 */
export function useTerminalAttention(
  facts: ReadonlyMap<string, TerminalTabFacts> | null,
  seen: () => ReadonlySet<string>,
): { visible: TerminalAttention[]; dismiss(key: string): void } {
  const previous = useRef<ReadonlyMap<string, TerminalTabFacts> | null>(null);
  const [alerts, setAlerts] = useState<TerminalAttention[]>([]);
  const seenNow = useEffectEvent(() => seen());
  // When each completion was first shown, for its timeout (see scheduleCompletionExpiry).
  const shownAt = useRef(new Map<string, number>());

  useEffect(() => {
    if (!facts) {
      previous.current = null;
      return;
    }
    const before = previous.current;
    previous.current = facts;
    const changes = before ? terminalAttentionChanges(before, facts, seenNow()) : [];
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-adjust-state-on-prop-change -- external event snapshots drive transient notifications; dismissed alerts and transition history cannot be derived from the current snapshot alone.
    setAlerts((current) => {
      const kept = retainTerminalAttention(current, facts);
      const fresh = changes.filter((change) => !kept.some((alert) => alert.key === change.key));
      const updated = [...fresh, ...kept].slice(0, MAX_PENDING);
      // Unchanged alerts keep their array, so the done timeout is not restarted.
      return sameAlerts(current, updated) ? current : updated;
    });
  }, [facts]);

  // Only the display is limited: hidden alerts wait and show when a slot frees up.
  const visible = alerts.toSorted((left, right) => URGENT(left) - URGENT(right)).slice(0, MAX_VISIBLE);
  const visibleDone = visible.filter((alert) => alert.kind === "done").map((alert) => alert.key).join("\n");

  useEffect(() => scheduleCompletionExpiry({
    shownAt: shownAt.current,
    alerts,
    visibleDoneKeys: visibleDone ? visibleDone.split("\n") : [],
    expire: (keep) => setAlerts((current) => current.filter(keep)),
  }), [alerts, visibleDone]);

  const dismiss = (key: string) => setAlerts((current) => current.filter((alert) => alert.key !== key));
  return { visible, dismiss };
}
