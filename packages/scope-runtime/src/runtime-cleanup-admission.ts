import type { LeasedRuntime } from "./pi-runtime-leases.js";

/** Capacity is released only after the launcher's ownership-checked cleanup. */
export function createRuntimeCleanupAdmission(options: {
  runtimes: Map<string, LeasedRuntime>;
  stop(handle: string): Promise<void>;
  active?: () => Promise<ReadonlySet<string>>;
  closed(): boolean;
  changed(): void;
}) {
  // One operation per tracked runtime (at most 32), removed after settlement.
  const pending = new Map<string, Promise<void>>();
  let pruning: Promise<void> | undefined;

  function stop(handle: string): Promise<void> {
    const existing = pending.get(handle);
    if (existing) return existing;
    const runtime = options.runtimes.get(handle);
    if (!runtime) return Promise.resolve();
    if (pending.size >= 32) return Promise.reject(new Error("Scope runtime cleanup exceeds capacity"));
    const work = Promise.resolve().then(() => options.stop(handle)).then(() => {
      if (options.runtimes.get(handle) === runtime) options.runtimes.delete(handle);
      options.changed();
    }).finally(() => { pending.delete(handle); });
    pending.set(handle, work);
    return work;
  }

  function prune(): Promise<void> {
    if (pruning) return pruning;
    if (!options.active || options.closed()) return Promise.resolve();
    const active = options.active;
    // A create completing after this snapshot cannot be judged by it.
    const tracked = [...options.runtimes.entries()];
    pruning = Promise.resolve().then(active).then(async running => {
      for (const [handle, runtime] of tracked) {
        if (!running.has(handle) && options.runtimes.get(handle) === runtime) await stop(handle);
      }
    }).catch((error: unknown) => {
      console.warn("[scope-runtime] runtime liveness cleanup failed:",
        error instanceof Error ? error.name : "UnknownError");
    }).finally(() => { pruning = undefined; });
    return pruning;
  }

  return { stop, prune, async drain() {
    await pruning;
    await Promise.allSettled([...pending.values()]);
  } };
}
