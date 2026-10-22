/** Bound acknowledgement and shutdown waits even when original cancellation
 * never confirms. A timeout never establishes terminal evidence. */
export const RELAY_SHUTDOWN_TIMEOUT_MS = 9_000;
export const RELAY_SHUTDOWN_FORCE_EXIT_MS = 9_500;

export function waitForRelayWork(work: Promise<unknown>, limit: number | AbortSignal, shutdownSignal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const signal = typeof limit === "number" ? shutdownSignal : limit;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve(completed && !signal?.aborted);
    };
    const aborted = () => finish(false);
    void work.then((result) => finish(result !== false), () => finish(false));
    if (signal?.aborted) finish(false);
    else {
      signal?.addEventListener("abort", aborted, { once: true });
      if (typeof limit === "number") timer = setTimeout(() => finish(false), limit);
    }
  });
}

/** Same inventory as active admission leases; completion includes any confirmed
 * cancellation's receipt barrier. No new requests enter after admission closes. */
export function createRelayRequestDrain() {
  const active = new Map<AbortController, ReturnType<typeof Promise.withResolvers<void>>>();
  return {
    add(controller: AbortController) { active.set(controller, Promise.withResolvers<void>()); },
    delete(controller: AbortController) {
      active.get(controller)?.resolve();
      return active.delete(controller);
    },
    async close(timeoutMs: number, shutdownSignal?: AbortSignal): Promise<boolean> {
      const completions = [...active.values()].map((item) => item.promise);
      for (const controller of active.keys()) controller.abort("relay shutting down");
      const completed = await waitForRelayWork(Promise.all(completions), timeoutMs, shutdownSignal);
      active.clear();
      return completed;
    },
  };
}
