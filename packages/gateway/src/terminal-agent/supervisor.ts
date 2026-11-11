import type { TerminalAgents } from "./agents.js";

const DEFAULT_INTERVAL_MS = 5_000;
const MAX_TRACKED = 1_024;

/** Runs agent supervision (child notes, end-with-parent, pruning) on a timer until closed. */
export function startTerminalAgentSupervisor(options: { agents: TerminalAgents; intervalMs?: number }) {
  const state = new Map<string, string>();
  let running: Promise<void> | null = null;
  let closed = false;
  const timer = setInterval(() => {
    if (closed || running) return;
    running = options.agents.supervise(state)
      .catch((error: unknown) => {
        console.warn("[gateway] terminal agent supervision failed", error instanceof Error ? error.name : "unknown_error");
      })
      .finally(() => {
        running = null;
        // State only remembers last-noted words; drop the oldest past the cap.
        while (state.size > MAX_TRACKED) {
          const oldest = state.keys().next().value;
          if (oldest === undefined) break;
          state.delete(oldest);
        }
      });
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
      state.clear();
    },
  };
}
