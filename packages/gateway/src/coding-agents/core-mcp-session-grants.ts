/**
 * Live Matrix Core MCP bearers by coding session (spec 2691).
 *
 * A Codex process receives its bearer once, in its spawn environment, and can
 * run far longer than the 35-minute capability lifetime. The bearer therefore
 * stays the same for the session and is renewed while the session is live;
 * it is revoked when the session stops, exits, fails to persist, or the
 * manager shuts down. Bounded like the capability registry (128): evicting
 * the oldest entry also revokes it, so no bearer outlives its tracking.
 */
const MAX_CORE_MCP_SESSIONS = 128;

export interface CoreMcpSessionGrant { revoke(): void; renew(): boolean }

export function createCoreMcpSessionGrants(max = MAX_CORE_MCP_SESSIONS) {
  const grants = new Map<string, CoreMcpSessionGrant>();
  function revoke(sessionId: string): void {
    const grant = grants.get(sessionId);
    grants.delete(sessionId);
    grant?.revoke();
  }
  return {
    track(sessionId: string, grant: CoreMcpSessionGrant): void {
      revoke(sessionId);
      while (grants.size >= max) revoke(grants.keys().next().value as string);
      grants.set(sessionId, grant);
    },
    revoke,
    revokeAll(): void {
      for (const sessionId of [...grants.keys()]) revoke(sessionId);
    },
    /** Renews each grant whose session is still live; revokes the rest. */
    async renewLive(isLive: (sessionId: string) => Promise<boolean>): Promise<void> {
      for (const [sessionId, grant] of [...grants]) {
        let live = false;
        try { live = await isLive(sessionId); }
        catch (error: unknown) {
          // An unreadable record is not proof the session stopped; keep it until the next sweep.
          console.warn("[core-mcp] session liveness unavailable", error instanceof Error ? error.name : "UnknownError");
          grant.renew();
          continue;
        }
        if (grants.get(sessionId) !== grant) continue;
        if (!live || !grant.renew()) revoke(sessionId);
      }
    },
  };
}
