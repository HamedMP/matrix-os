import type { CanonicalCliIdleControl } from "./cli-process.js";
import type { CanonicalProviderRunEvent } from "./provider-adapter.js";

// Claude has three approval controllers plus input, each capped at 16 requests.
const HUMAN_WAIT_LIMIT = 64;

/** Track canonical human requests without coupling the process clock to a provider protocol. */
export function createCanonicalCliHumanWait(emit: (event: CanonicalProviderRunEvent) => void) {
  const pending = new Set<string>(); // capped; removed on resolution and drained on close
  let idle: CanonicalCliIdleControl | undefined;
  let closed = false;
  return {
    attach(control: CanonicalCliIdleControl) {
      if (closed) return;
      idle = control;
      if (pending.size) idle.pause();
    },
    emit(event: CanonicalProviderRunEvent) {
      if (closed) return;
      const key = event.type.startsWith("approval.") && "approvalId" in event
        ? `approval:${event.approvalId}`
        : event.type.startsWith("input.") && "requestId" in event ? `input:${event.requestId}` : undefined;
      if (key && (event.type === "approval.requested" || event.type === "input.requested")) {
        if (!pending.has(key) && pending.size >= HUMAN_WAIT_LIMIT) throw new Error("Human request limit exceeded");
        pending.add(key);
        idle?.pause();
      } else if (key && (event.type === "approval.resolved" || event.type === "input.resolved")) {
        if (pending.delete(key) && pending.size === 0) idle?.resume();
      }
      emit(event);
    },
    close() {
      closed = true;
      pending.clear();
      idle = undefined;
    },
  };
}
