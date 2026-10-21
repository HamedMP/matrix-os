import { realpath } from "node:fs/promises";
import { markSessionStartClean } from "./coding-agents/session-start-cleanup-proof.js";

export type CleanSessionStartFailure = <T extends object>(result: T, stillAllowed?: () => boolean) => Promise<T>;
export interface SessionStartScope<Input, Result> {
  startSession(input: Input): Promise<Result>;
  cleanFailure: CleanSessionStartFailure;
}

// All managers for a Computer share the same namespace, including symlink aliases.
// Reject capacity overflow; never evict an active reservation. Finally releases it.
const pending = new Set<string>();
export class SessionStartBusyError extends Error {
  constructor() { super("Session runtime is unavailable"); }
}
export function createSessionStartGuard(homePath: string, hasSession: (sessionId: string) => Promise<boolean>) {
  async function reserve<T>(sessionId: string, ownerId: string,
    operation: (cleanFailure: CleanSessionStartFailure) => Promise<T>): Promise<T> {
    let canonicalHome: string;
    try { canonicalHome = await realpath(homePath); }
    catch (error: unknown) {
      console.warn("[session-start] Computer path unavailable", error instanceof Error ? error.name : "UnknownError");
      throw new SessionStartBusyError();
    }
    const key = `${canonicalHome}\0${sessionId}`;
    if (pending.has(key) || pending.size >= 64) throw new SessionStartBusyError();
    pending.add(key);
    let active = true;
    try {
      return await operation(async (result, stillAllowed) => {
        if (!active || (stillAllowed && !stillAllowed())) return result;
        try {
          const exists = await hasSession(sessionId);
          return !active || exists || (stillAllowed && !stillAllowed()) ? result : markSessionStartClean(result, ownerId, sessionId);
        } catch (error: unknown) {
          console.warn("[session-start] Ownership lookup failed", error instanceof Error ? error.name : "UnknownError");
          return result;
        }
      });
    } finally { active = false; pending.delete(key); }
  }
  async function run<T extends object>(sessionId: string, ownerId: string, unavailable: T,
    operation: (cleanFailure: CleanSessionStartFailure) => Promise<T>): Promise<T> {
    try { return await reserve(sessionId, ownerId, operation); }
    catch (error: unknown) { if (error instanceof SessionStartBusyError) return unavailable; throw error; }
  }
  return Object.assign(run, { reserve });
}
