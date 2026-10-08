import type { FundedAiRequestClass } from "@matrix-os/contracts";

/**
 * Local ordering for funded requests this gateway sends itself. The platform
 * reservation point is the owner-wide authority for priority; this queue only
 * orders retries after a busy (429) answer, keeps interactive turns ahead of
 * background work, and bounds how long anyone waits.
 */
export type FundedAttemptResult<T> = { kind: "done"; value: T } | { kind: "busy" };

export interface FundedAdmissionQueue {
  run<T>(
    input: { requestClass: FundedAiRequestClass; signal?: AbortSignal },
    attempt: () => Promise<FundedAttemptResult<T>>,
  ): Promise<T>;
  close(): void;
}

export class FundedAdmissionTimeoutError extends Error {
  constructor() {
    super("Funded AI capacity wait timed out");
    this.name = "FundedAdmissionTimeoutError";
  }
}

export class FundedAdmissionFullError extends Error {
  constructor() {
    super("Funded AI capacity queue is full");
    this.name = "FundedAdmissionFullError";
  }
}

export class FundedAdmissionClosedError extends Error {
  constructor() {
    super("Funded AI capacity queue is closed");
    this.name = "FundedAdmissionClosedError";
  }
}

const MAX_WAITERS = 64;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;
const WAIT_BOUND_MS: Record<FundedAiRequestClass, number> = {
  interactive: 2 * 60_000,
  background: 10 * 60_000,
};

interface Waiter {
  requestClass: FundedAiRequestClass;
  seq: number;
  deadline: number;
  backoffMs: number;
  mustWait: boolean;
  inFlight: boolean;
  settled: boolean;
  attempt: () => Promise<FundedAttemptResult<unknown>>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  detach(): void;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createFundedAdmissionQueue(dependencies: {
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
} = {}): FundedAdmissionQueue {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const lifetime = new AbortController();
  // Sorted interactive first, then FIFO; bounded by MAX_WAITERS.
  const waiters: Waiter[] = [];
  let sequence = 0;
  let pumping = false;
  let closed = false;

  const rank = (waiter: Waiter) => (waiter.requestClass === "interactive" ? 0 : 1);

  function settle(waiter: Waiter, outcome: { value: unknown } | { error: unknown }): void {
    if (waiter.settled) return;
    waiter.settled = true;
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    waiter.detach();
    if ("error" in outcome) waiter.reject(outcome.error);
    else waiter.resolve(outcome.value);
  }

  function enqueue(waiter: Waiter): void {
    if (waiters.length >= MAX_WAITERS) throw new FundedAdmissionFullError();
    const index = waiters.findIndex((other) => rank(other) > rank(waiter)
      || (rank(other) === rank(waiter) && other.seq > waiter.seq));
    if (index < 0) waiters.push(waiter);
    else waiters.splice(index, 0, waiter);
    void pump();
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (waiters.length > 0 && !closed) {
        const head = waiters[0]!;
        if (now() >= head.deadline) {
          settle(head, { error: new FundedAdmissionTimeoutError() });
          continue;
        }
        if (head.mustWait) {
          const waitMs = head.backoffMs;
          head.backoffMs = Math.min(head.backoffMs * 2, MAX_BACKOFF_MS);
          head.mustWait = false;
          try {
            await sleep(waitMs, lifetime.signal);
          } catch (error: unknown) {
            if (closed) return;
            // Sleep only rejects on shutdown; anything else is logged and the pump restarts on the next enqueue.
            console.warn("[funded-admission] backoff failed:", error instanceof Error ? error.name : "UnknownError");
            return;
          }
          // Re-evaluate: a higher-priority waiter may have arrived while sleeping.
          continue;
        }
        head.inFlight = true;
        let result: FundedAttemptResult<unknown>;
        try {
          result = await head.attempt();
        } catch (error: unknown) {
          head.inFlight = false;
          settle(head, { error });
          continue;
        }
        head.inFlight = false;
        if (head.settled) continue;
        if (result.kind === "done") settle(head, { value: result.value });
        else head.mustWait = true;
      }
    } finally {
      pumping = false;
    }
  }

  return {
    async run<T>(
      input: { requestClass: FundedAiRequestClass; signal?: AbortSignal },
      attempt: () => Promise<FundedAttemptResult<T>>,
    ): Promise<T> {
      if (closed) throw new FundedAdmissionClosedError();
      input.signal?.throwIfAborted();
      const startedAt = now();
      const canAttemptNow = input.requestClass === "interactive"
        ? !waiters.some((waiter) => waiter.requestClass === "interactive")
        : waiters.length === 0;
      if (canAttemptNow) {
        const first = await attempt();
        if (first.kind === "done") return first.value;
        if (closed) throw new FundedAdmissionClosedError();
      }
      return await new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          if (waiter.inFlight) return; // settled by the pump once the attempt returns
          settle(waiter, { error: input.signal?.reason });
        };
        const waiter: Waiter = {
          requestClass: input.requestClass,
          seq: sequence += 1,
          deadline: startedAt + WAIT_BOUND_MS[input.requestClass],
          backoffMs: INITIAL_BACKOFF_MS,
          mustWait: canAttemptNow,
          inFlight: false,
          settled: false,
          attempt: async () => {
            if (input.signal?.aborted) throw input.signal.reason;
            return await attempt();
          },
          resolve: resolve as (value: unknown) => void,
          reject,
          detach: () => input.signal?.removeEventListener("abort", onAbort),
        };
        input.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          enqueue(waiter);
        } catch (error: unknown) {
          waiter.detach();
          reject(error);
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      lifetime.abort(new FundedAdmissionClosedError());
      for (const waiter of [...waiters]) settle(waiter, { error: new FundedAdmissionClosedError() });
    },
  };
}
