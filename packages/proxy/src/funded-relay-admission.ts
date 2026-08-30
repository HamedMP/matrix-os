import type { FundedRelayConfig } from "./funded-relay-config.js";

const RATE_WINDOW_MS = 60_000;

interface RuntimeAdmission {
  active: number;
  count: number;
  windowStartedAt: number;
  lastTouchedAt: number;
}

export interface AdmissionLease {
  release(): void;
}

export class AdmissionController {
  private active = 0;
  private closed = false;
  private globalCount = 0;
  private globalWindowStartedAt = 0;
  private readonly runtimes = new Map<string, RuntimeAdmission>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: Pick<
      FundedRelayConfig,
      | "globalConcurrency"
      | "globalRateLimitPerMinute"
      | "runtimeConcurrency"
      | "rateLimitPerMinute"
      | "maxRuntimeEntries"
    >,
    private readonly now: () => number,
  ) {
    this.cleanupTimer = setInterval(() => this.sweep(this.now(), true), RATE_WINDOW_MS);
    this.cleanupTimer.unref?.();
  }

  acquire(runtimeId: string): AdmissionLease | null {
    if (this.closed || this.active >= this.config.globalConcurrency) return null;
    const now = this.now();
    this.sweep(now, false);
    if (now - this.globalWindowStartedAt >= RATE_WINDOW_MS) {
      this.globalCount = 0;
      this.globalWindowStartedAt = now;
    }
    if (this.globalCount >= this.config.globalRateLimitPerMinute) return null;
    let state = this.runtimes.get(runtimeId);
    if (!state) {
      if (this.runtimes.size >= this.config.maxRuntimeEntries) return null;
      state = { active: 0, count: 0, windowStartedAt: now, lastTouchedAt: now };
      this.runtimes.set(runtimeId, state);
    }
    if (now - state.windowStartedAt >= RATE_WINDOW_MS) {
      state.count = 0;
      state.windowStartedAt = now;
    }
    state.lastTouchedAt = now;
    if (state.active >= this.config.runtimeConcurrency || state.count >= this.config.rateLimitPerMinute) {
      return null;
    }

    state.active += 1;
    state.count += 1;
    this.active += 1;
    this.globalCount += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        state.active = Math.max(0, state.active - 1);
        state.lastTouchedAt = this.now();
        this.active = Math.max(0, this.active - 1);
      },
    };
  }

  close(): void {
    this.closed = true;
    clearInterval(this.cleanupTimer);
    this.runtimes.clear();
  }

  private sweep(now: number, force: boolean): void {
    if (!force && this.runtimes.size < this.config.maxRuntimeEntries) return;
    for (const [runtimeId, state] of this.runtimes) {
      if (state.active === 0 && now - state.lastTouchedAt >= RATE_WINDOW_MS) {
        this.runtimes.delete(runtimeId);
      }
    }
  }
}
