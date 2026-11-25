// Spec 2710: what this window knows about each open team terminal, shared by
// its socket (which writes) and its pane header (which reads). Serializable
// plain records, bounded, and cleared with the window's session.
import type {
  CollaborationTeamTerminalPresenceFrame,
  CollaborationTeamTerminalRejectionCode,
  TeamTerminalProjection,
} from "@matrix-os/contracts";

/** Above the Team list's 200 entries, so listing never evicts an open pane's record. */
const MAX_SESSIONS = 256;

export interface TeamSessionState {
  projection?: TeamTerminalProjection;
  presence?: Pick<CollaborationTeamTerminalPresenceFrame, "inputMode" | "participants" | "marks">;
  /** The last refused input, shown briefly. */
  rejected?: { code: CollaborationTeamTerminalRejectionCode; at: number };
  /** Access ended (revoked, unshared or the terminal ended). */
  ended?: boolean;
}

type Listener = () => void;

const sessions = new Map<string, TeamSessionState>();
const listeners = new Set<Listener>();
const MAX_LISTENERS = 256;

function emit(): void {
  for (const listener of [...listeners]) {
    try { listener(); }
    catch (error: unknown) { console.warn("[terminal-window] team listener failed:", error instanceof Error ? error.name : "UnknownError"); }
  }
}

export function teamSession(scopeId: string): TeamSessionState | undefined {
  return sessions.get(scopeId);
}

export function updateTeamSession(scopeId: string, change: Partial<TeamSessionState>): void {
  const current = sessions.get(scopeId);
  sessions.delete(scopeId);
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  sessions.set(scopeId, { ...current, ...change });
  emit();
}

export function clearTeamSessions(): void {
  sessions.clear();
  emit();
}

export function subscribeTeamSessions(listener: Listener): () => void {
  if (listeners.size >= MAX_LISTENERS) throw new Error("Team session listener capacity reached");
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
