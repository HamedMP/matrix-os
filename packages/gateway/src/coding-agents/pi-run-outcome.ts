export type PiNativeRunOutcome = "completed" | "failed" | "aborted";

// agent_settled means Pi has finished continuation/retries, not that inference
// succeeded. Retain only a coarse latest native outcome, never provider errors.
export function createPiRunOutcomeTracker() {
  let outcome: PiNativeRunOutcome = "completed";

  function observeMessage(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.role !== "assistant") return;
    switch (message.stopReason) {
      case "error": outcome = "failed"; break;
      case "aborted": outcome = "aborted"; break;
      case "stop":
      case "toolUse":
      case "length": outcome = "completed"; break;
      // Legacy/malformed frames cannot erase an observed native failure.
      default: break;
    }
  }

  return {
    observe(event: Record<string, unknown>): void {
      if (event.type === "message_end" || event.type === "turn_end") {
        observeMessage(event.message);
      } else if (event.type === "agent_end" && Array.isArray(event.messages)) {
        for (let index = event.messages.length - 1; index >= 0; index--) {
          const message: unknown = event.messages[index];
          if (message && typeof message === "object" && "role" in message && message.role === "assistant") {
            observeMessage(message);
            break;
          }
        }
      } else if (event.type === "auto_retry_end") {
        if (event.success === false) outcome = "failed";
        else if (event.success === true) outcome = "completed";
      }
    },
    current(): PiNativeRunOutcome { return outcome; },
  };
}
