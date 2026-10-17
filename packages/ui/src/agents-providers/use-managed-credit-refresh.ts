import { useEffect, useRef } from "react";
import type { ManagedCreditRefreshResult } from "./managed-credit-refresh.js";

const CADENCE_MS = 45_000;
const RETRY_MS = [15_000, 30_000, 60_000];

/** Settings-only lifecycle; hidden Chat consumers never opt in. */
export function useManagedCreditRefresh(
  owner: { refreshManagedCredit: (signal?: AbortSignal) => Promise<ManagedCreditRefreshResult> },
  enabled: boolean,
): void {
  const lifetime = useRef<{ owner: typeof owner; nextAt: number; failures: number; stopped: boolean } | null>(null);
  useEffect(() => {
    if (lifetime.current?.owner !== owner) lifetime.current = { owner, nextAt: Date.now() + CADENCE_MS, failures: 0, stopped: false };
    if (!enabled) return;
    const state = lifetime.current;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | null = null;
    const visible = () => enabled && document.visibilityState !== "hidden" && navigator.onLine !== false;
    const cancel = () => { clearTimeout(timer); timer = undefined; request?.abort(); };
    const check = () => {
      clearTimeout(timer); timer = undefined;
      if (!alive || state.stopped || !visible()) { request?.abort(); return; }
      if (request) return;
      const delay = state.nextAt - Date.now();
      if (delay > 0) { timer = setTimeout(check, delay); return; }
      request = new AbortController();
      const pending = request;
      void owner.refreshManagedCredit(pending.signal).then(result => {
        if (!alive || request !== pending) return;
        request = null;
        if (result === "unsupported") state.stopped = true;
        else if (result === "updated") { state.failures = 0; state.nextAt = Date.now() + CADENCE_MS; }
        // A visibility/online pause is not a failed observation. Keep its due
        // deadline so a quick return reconciles as soon as cancellation settles.
        else if (result !== "aborted") { state.nextAt = Date.now() + RETRY_MS[Math.min(state.failures++, RETRY_MS.length - 1)]!; }
        check();
      });
    };
    const reconcile = () => { if (!visible()) cancel(); else check(); };
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    window.addEventListener("offline", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    check();
    return () => {
      alive = false;
      clearTimeout(timer);
      timer = undefined;
      request?.abort();
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
      window.removeEventListener("offline", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [owner, enabled]);
}
