import { z } from "zod/v4";

// Private owner-only control socket protocol; old runners reject it and are not auto-reaped.
export const CodexHibernateControlSchema = z.object({
  type: z.literal("hibernate"),
  providerThreadId: z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  clientRequestId: z.string().min(1).max(160).regex(/^req_[A-Za-z0-9_-]+$/),
}).strict();

/** Reserve the idle boundary synchronously so queued input cannot race a successful handshake. */
export function createCodexIdleHibernation(readState) {
  let closing = false;
  return {
    get closing() { return closing; },
    prepare(providerThreadId) {
      const state = readState();
      if (state.providerThreadId !== providerThreadId) return false;
      if (closing) return true;
      if (!state.completedTurns || state.active || state.pending || state.otherControls) return false;
      closing = true;
      return true;
    },
  };
}
