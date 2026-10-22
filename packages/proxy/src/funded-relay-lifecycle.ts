/** Bound acknowledgement and shutdown waits even when original cancellation
 * never confirms. A timeout never establishes terminal evidence. */
export function waitForRelayWork(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void work.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
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
    async close(timeoutMs: number) {
      const completions = [...active.values()].map((item) => item.promise);
      for (const controller of active.keys()) controller.abort("relay shutting down");
      await waitForRelayWork(Promise.all(completions), timeoutMs);
      active.clear();
    },
  };
}
