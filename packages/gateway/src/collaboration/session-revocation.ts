import type { DirectSessionService } from "./direct-sessions.js";
import type { CollaborationRevocationEnforcer } from "./revocation-enforcer.js";

/** Keep session lifecycle wiring outside the gateway composition entrypoint. */
export function subscribeSessionRevocations(
  sessions: Pick<DirectSessionService, "subscribeEnded" | "hasFreshSessionFor">,
  enforcer: () => Pick<CollaborationRevocationEnforcer, "onSessionEnded"> | undefined,
): () => void {
  return sessions.subscribeEnded((session, reason, cause) => {
    if (reason === "expired" && cause === "session_lifetime" && sessions.hasFreshSessionFor(session)) return;
    enforcer()?.onSessionEnded(session, reason);
  });
}
