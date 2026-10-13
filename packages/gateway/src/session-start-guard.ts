import { markSessionStartClean } from "./coding-agents/session-start-cleanup-proof.js";

/** A pending attempt owns its session id until it settles. Never evict live work. */
export function createSessionStartGuard(hasSession: (sessionId: string) => Promise<boolean>) {
  const pending = new Set<string>();
  return async function run<T extends object>(sessionId: string, ownerId: string, unavailable: T,
    operation: (cleanFailure: (result: T) => Promise<T>) => Promise<T>): Promise<T> {
    if (pending.has(sessionId) || pending.size >= 64) return unavailable;
    pending.add(sessionId);
    try {
      return await operation(async result => {
        try {
          return await hasSession(sessionId) ? result : markSessionStartClean(result, ownerId, sessionId);
        } catch (error: unknown) {
          console.warn("[session-start] Ownership lookup failed", error instanceof Error ? error.name : "UnknownError");
          return result;
        }
      });
    } finally { pending.delete(sessionId); }
  };
}
