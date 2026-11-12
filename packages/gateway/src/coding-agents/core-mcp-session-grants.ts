/**
 * Live Matrix Core MCP bearers by coding session (spec 2691). A session's
 * bearer is revoked when the session stops, exits, or the manager shuts down.
 * Bounded like the capability registry (128): evicting the oldest entry also
 * revokes it, so no bearer outlives its tracking.
 */
const MAX_CORE_MCP_SESSIONS = 128;

export function createCoreMcpSessionGrants(max = MAX_CORE_MCP_SESSIONS) {
  const grants = new Map<string, () => void>();
  function revoke(sessionId: string): void {
    const revokeGrant = grants.get(sessionId);
    grants.delete(sessionId);
    revokeGrant?.();
  }
  return {
    track(sessionId: string, revokeGrant: () => void): void {
      revoke(sessionId);
      while (grants.size >= max) {
        const oldest = grants.keys().next().value as string;
        revoke(oldest);
      }
      grants.set(sessionId, revokeGrant);
    },
    revoke,
    revokeAll(): void {
      for (const sessionId of [...grants.keys()]) revoke(sessionId);
    },
  };
}
