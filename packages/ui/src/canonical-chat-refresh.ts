/** One in-flight snapshot and one dirty bit, scoped to a selected Chat.
 * The callback returns false when the snapshot could not be synchronized.
 * Stream health does not discharge that synchronization obligation.
 */
export function createCanonicalChatRefresh(refresh: () => Promise<boolean>) {
  let disposed = false;
  let inFlight = false;
  let pending = false;
  let retrying = false;
  let retryDelay = 2_000;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    timer = undefined;
    if (disposed || inFlight) return;
    inFlight = true;
    pending = false;
    let synchronized = false;
    try {
      synchronized = await refresh();
    } catch (error: unknown) {
      console.warn("[canonical-chat] snapshot refresh failed:", error instanceof Error ? error.name : "UnknownError");
    }
    inFlight = false;
    if (disposed) return;
    retrying = !synchronized;
    if (!synchronized) {
      pending = true;
      timer = setTimeout(() => void run(), retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10_000);
    } else {
      retryDelay = 2_000;
      if (pending) void run();
    }
  };

  return {
    schedule(delay = 0) {
      if (disposed) return;
      pending = true;
      if (inFlight || retrying) return;
      if (timer !== undefined) {
        if (delay > 0) return;
        clearTimeout(timer);
        timer = undefined;
      }
      if (delay === 0) void run();
      else timer = setTimeout(() => void run(), delay);
    },
    dispose() {
      disposed = true;
      pending = false;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
