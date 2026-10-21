/** Process-private evidence from the runtime that a failed attempt has no live child. */
const cleanFailures = new WeakMap<object, { ownerId: string; sessionId: string }>();
export function markSessionStartClean<T extends object>(result: T, ownerId: string, sessionId: string): T {
  cleanFailures.set(result, { ownerId, sessionId });
  return result;
}
export function isSessionStartClean(result: unknown, ownerId: string, sessionId: string): boolean {
  if (!result || typeof result !== "object") return false;
  const proof = cleanFailures.get(result);
  return proof?.ownerId === ownerId && proof.sessionId === sessionId;
}

/** A confirmed stop is distinct from absence of a never-dispatched startup. */
const confirmedStops = new WeakMap<object, { ownerId: string; sessionId: string }>();
export function markSessionStopConfirmed<T extends object>(result: T, ownerId: string, sessionId: string): T {
  confirmedStops.set(result, { ownerId, sessionId });
  return result;
}
export function isSessionStopConfirmed(result: unknown, ownerId: string, sessionId: string): boolean {
  if (!result || typeof result !== "object") return false;
  const proof = confirmedStops.get(result);
  return proof?.ownerId === ownerId && proof.sessionId === sessionId;
}
