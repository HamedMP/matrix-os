// Backoff poller for the OAuth connect flow. After the consent URL opens in
// the external browser, the section polls POST /api/integrations/sync (via
// the store) with growing intervals until the new connection shows up or the
// window expires (~2 minutes). The poller is UI-free and injectable so tests
// can drive it with fake timers.

// 2s + 3s + 5s + 8s + 9×10s ≈ 108 seconds of coverage, then we give up.
export const DEFAULT_CONNECT_POLL_INTERVALS_MS = [
  2_000, 3_000, 5_000, 8_000,
  10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000,
];

export interface ConnectPollOptions {
  // One sync attempt. Rejections are logged and treated as "not yet".
  tick: () => Promise<void> | void;
  // Checked after every tick; return true when the new connection landed.
  isDone: () => boolean;
  // Called exactly once, with found=true on success and false on timeout.
  onSettled: (found: boolean) => void;
  // Injectable for tests; defaults to ~2 minutes of backoff.
  intervals?: number[];
}

// Returns a cancel function. Cancelling is idempotent and guarantees
// onSettled is never called afterwards.
export function startConnectPoll(options: ConnectPollOptions): () => void {
  const intervals = options.intervals ?? DEFAULT_CONNECT_POLL_INTERVALS_MS;
  let cancelled = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let index = 0;

  const settle = (found: boolean): void => {
    if (settled || cancelled) return;
    settled = true;
    options.onSettled(found);
  };

  const step = async (): Promise<void> => {
    if (cancelled || settled) return;
    if (options.isDone()) {
      settle(true);
      return;
    }
    try {
      await options.tick();
    } catch (err: unknown) {
      console.warn(
        "[integrations] connect poll tick failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (cancelled || settled) return;
    if (options.isDone()) {
      settle(true);
      return;
    }
    index += 1;
    if (index >= intervals.length) {
      settle(false);
      return;
    }
    timer = setTimeout(() => {
      void step();
    }, intervals[index]);
  };

  if (intervals.length === 0) {
    settle(false);
    return () => {
      cancelled = true;
    };
  }

  timer = setTimeout(() => {
    void step();
  }, intervals[0]);

  return () => {
    cancelled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
