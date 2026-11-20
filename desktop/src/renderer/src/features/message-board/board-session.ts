import { useConnection } from "../../stores/connection";
import { isCurrentRuntimeGeneration } from "../../stores/runtime-generation";

/**
 * Only the session that sent a request may expire the sign-in: a 401 that
 * lands after a computer switch or a new sign-in belongs to the old session.
 */
export function boardUnauthorizedHandler(session: { authGeneration: number; runtimeGeneration: number }, expire: () => void): () => void {
  return () => {
    if (useConnection.getState().authGeneration !== session.authGeneration) return;
    if (!isCurrentRuntimeGeneration(session.runtimeGeneration)) return;
    expire();
  };
}
