const RENEWAL_DEADLINE_MS = 30_000;
const STOP_DRAIN_MS = 1_000;

export class RuntimeHeartbeatTimeoutError extends Error {
  constructor() {
    super("Runtime renewal timed out");
    this.name = "RuntimeHeartbeatTimeoutError";
  }
}

interface RenewalAttempt {
  controller: AbortController;
  /** The underlying work may ignore abort. Stop gives it only a bounded drain. */
  work: Promise<void>;
}

/** Keep one admitted runtime lease alive; Stop never waits indefinitely for a hung preflight. */
export function startRuntimeHeartbeat(
  renew: (signal: AbortSignal) => Promise<void>,
  onFailure: (error: unknown) => void | Promise<void>,
  intervalMs = 30_000,
): { stop(): Promise<void> } {
  let stopped = false;
  let inFlight: RenewalAttempt | undefined;
  const interval = setInterval(tick, Number.isFinite(intervalMs) ? Math.max(1, Math.trunc(intervalMs)) : 30_000);
  interval.unref();

  function tick(): void {
    if (stopped || inFlight) return;
    const controller = new AbortController();
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    const work = Promise.resolve().then(() => {
      if (stopped || controller.signal.aborted) return;
      return renew(controller.signal);
    });
    const attempt: RenewalAttempt = { controller, work };
    inFlight = attempt;
    const deadline = setTimeout(() => controller.abort(new RuntimeHeartbeatTimeoutError()), RENEWAL_DEADLINE_MS);
    deadline.unref();
    void Promise.race([work, aborted]).then(
      () => finish(false, undefined),
      (error: unknown) => finish(true, error),
    );

    function finish(failed: boolean, error: unknown): void {
      clearTimeout(deadline);
      if (inFlight === attempt) inFlight = undefined;
      if (!failed || stopped) return;
      stopped = true;
      clearInterval(interval);
      try {
        void Promise.resolve(onFailure(error)).catch(callbackError => {
          console.warn("[bots] runtime renewal failure callback failed", callbackError instanceof Error ? callbackError.name : "UnknownError");
        });
      }
      catch (callbackError: unknown) {
        console.warn("[bots] runtime renewal failure callback failed", callbackError instanceof Error ? callbackError.name : "UnknownError");
      }
    }
  }

  tick();
  return {
    stop(): Promise<void> {
      stopped = true;
      clearInterval(interval);
      const attempt = inFlight;
      if (!attempt) return Promise.resolve();
      attempt.controller.abort(new Error("Runtime renewal stopped"));
      return new Promise<void>(resolve => {
        const drain = setTimeout(resolve, STOP_DRAIN_MS);
        void attempt.work.then(
          () => { clearTimeout(drain); resolve(); },
          () => { clearTimeout(drain); resolve(); },
        );
      });
    },
  };
}
