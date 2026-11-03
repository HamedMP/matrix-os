import { piProfileIdentity, SCOPE_RUNTIME_PI_LEASE_MS } from "./bot-profile.js";

export interface LeasedRuntime {
  executionGeneration: string;
  profileId: string;
  /** Process-local monotonic milliseconds; never persisted or sent over RPC. */
  expiresAt?: number;
}

/** Uses the supervisor's already bounded runtime map; no worker can grant itself authority. */
export function createPiRuntimeLeases(options: {
  runtimes: Map<string, LeasedRuntime>;
  expire(handle: string, runtime: LeasedRuntime): Promise<void>;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const pending = new Map<string, Promise<void>>(); // At most the supervisor's 32 runtimes; terminal cleanup below.
  const hasLeases = () => [...options.runtimes.values()].some(runtime => runtime.expiresAt !== undefined);
  function refreshTimer() {
    if (closed || !hasLeases()) { if (timer) clearInterval(timer); timer = undefined; return; }
    timer ??= setInterval(sweep, 30_000);
    timer.unref();
  }
  function sweep() {
    for (const [handle, runtime] of options.runtimes) {
      if (runtime.expiresAt === undefined || runtime.expiresAt > performance.now() || pending.has(handle)) continue;
      const work = options.expire(handle, runtime).catch((error: unknown) => {
        console.warn("[scope-runtime] expired runtime cleanup failed:", error instanceof Error ? error.name : "UnknownError");
      }).finally(() => { pending.delete(handle); refreshTimer(); });
      pending.set(handle, work);
    }
    refreshTimer();
  }
  return {
    register(handle: string) {
      const runtime = options.runtimes.get(handle);
      if (closed || !runtime || !piProfileIdentity(runtime.profileId)) throw new Error("Pi runtime lease unavailable");
      runtime.expiresAt = performance.now() + SCOPE_RUNTIME_PI_LEASE_MS;
      refreshTimer();
    },
    active(handle: string, generation: string) {
      const runtime = options.runtimes.get(handle);
      return !closed && !!runtime && !!piProfileIdentity(runtime.profileId)
        && runtime.executionGeneration === generation && runtime.expiresAt !== undefined && runtime.expiresAt > performance.now();
    },
    renew(handle: string, generation: string) {
      const runtime = options.runtimes.get(handle);
      if (closed || !runtime || !piProfileIdentity(runtime.profileId) || runtime.executionGeneration !== generation
        || runtime.expiresAt === undefined || runtime.expiresAt <= performance.now()) return false;
      runtime.expiresAt = performance.now() + SCOPE_RUNTIME_PI_LEASE_MS;
      return true;
    },
    forget(handle: string) { const runtime = options.runtimes.get(handle); if (runtime?.expiresAt !== undefined) runtime.expiresAt = performance.now(); refreshTimer(); },
    changed: refreshTimer,
    async close() { closed = true; refreshTimer(); await Promise.allSettled([...pending.values()]); },
  };
}
