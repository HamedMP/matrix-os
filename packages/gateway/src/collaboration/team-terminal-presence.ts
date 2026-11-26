/**
 * Spec 2710: who is in a team terminal and who typed what. Content-free by
 * construction: a mark records actor, time, output position, byte count and
 * whether Enter was pressed, never the keys. Every collection is bounded and
 * every per-scope entry (participants, marks, timer) leaves together.
 */
import {
  TEAM_TERMINAL_MAX_MARKS_SENT,
  TEAM_TERMINAL_MAX_PARTICIPANTS,
  type CollaborationRole,
  type CollaborationTeamTerminalInputMode,
  type CollaborationTeamTerminalMark,
  type CollaborationTeamTerminalParticipant,
  type CollaborationTeamTerminalPresenceState,
} from "@matrix-os/contracts";

const DEFAULT_MAX_SCOPES = 256;
const DEFAULT_MAX_MARKS = 512;
const DEFAULT_MIN_INTERVAL_MS = 250;
const TYPING_TTL_MS = 3_000;
const MAX_CONNECTIONS_SHOWN = 8;

interface ActorEntry {
  displayName: string;
  role: CollaborationRole;
  typingAt?: number;
}

interface ScopeEntry {
  ownerId: string;
  connections: Map<string, string>;
  actors: Map<string, ActorEntry>;
  marks: CollaborationTeamTerminalMark[];
  lastFlushAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface TeamTerminalInputDetail {
  bytes: number;
  enter: boolean;
  outputSeq: number;
}

export function describeTerminalInput(data: string): { bytes: number; enter: boolean } {
  return { bytes: Math.max(1, Buffer.byteLength(data)), enter: data.includes("\r") || data.includes("\n") };
}

export class TeamTerminalPresence {
  private readonly scopes = new Map<string, ScopeEntry>();
  private readonly now: () => number;
  private readonly maxScopes: number;
  private readonly maxMarks: number;
  private readonly minIntervalMs: number;

  constructor(private readonly options: {
    /** Called at most once per `minIntervalMs` per scope with the scope that changed. */
    onChange(scopeId: string): void;
    now?: () => number;
    maxScopes?: number;
    maxMarks?: number;
    minIntervalMs?: number;
  }) {
    this.now = options.now ?? Date.now;
    this.maxScopes = options.maxScopes ?? DEFAULT_MAX_SCOPES;
    this.maxMarks = options.maxMarks ?? DEFAULT_MAX_MARKS;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  }

  get size(): number {
    return this.scopes.size;
  }

  join(scopeId: string, connectionId: string, actor: { actorId: string; displayName: string; role: CollaborationRole; ownerId: string }): void {
    const entry = this.entry(scopeId, actor.ownerId);
    if (!entry.actors.has(actor.actorId) && entry.actors.size >= TEAM_TERMINAL_MAX_PARTICIPANTS) return;
    entry.connections.set(connectionId, actor.actorId);
    const previous = entry.actors.get(actor.actorId);
    entry.actors.set(actor.actorId, { displayName: actor.displayName, role: actor.role, ...(previous?.typingAt ? { typingAt: previous.typingAt } : {}) });
    this.schedule(scopeId, entry);
  }

  leave(scopeId: string, connectionId: string): void {
    const entry = this.scopes.get(scopeId);
    if (!entry) return;
    const actorId = entry.connections.get(connectionId);
    if (!entry.connections.delete(connectionId) || !actorId) return;
    if (![...entry.connections.values()].includes(actorId)) entry.actors.delete(actorId);
    if (entry.connections.size === 0) {
      // The last collaborator left: nobody is watching, so marks and timers go too.
      this.clearScope(scopeId);
      return;
    }
    this.schedule(scopeId, entry);
  }

  updateRole(scopeId: string, actorId: string, role: CollaborationRole): void {
    const entry = this.scopes.get(scopeId);
    const actor = entry?.actors.get(actorId);
    if (!entry || !actor || actor.role === role) return;
    actor.role = role;
    this.schedule(scopeId, entry);
  }

  /** Records who typed; the owner may type from their own tab without a collaborator socket. */
  noteInput(scopeId: string, actorId: string, detail: TeamTerminalInputDetail): void {
    const entry = this.scopes.get(scopeId);
    if (!entry) return;
    const at = this.now();
    const actor = entry.actors.get(actorId);
    if (actor) actor.typingAt = at;
    entry.marks.push({
      actorId,
      at: new Date(at).toISOString(),
      outputSeq: String(Math.max(0, Math.trunc(detail.outputSeq))),
      bytes: Math.min(Math.max(1, Math.trunc(detail.bytes)), 32 * 1024),
      enter: detail.enter,
    });
    if (entry.marks.length > this.maxMarks) entry.marks.splice(0, entry.marks.length - this.maxMarks);
    this.schedule(scopeId, entry);
  }

  changed(scopeId: string): void {
    const entry = this.scopes.get(scopeId);
    if (entry) this.schedule(scopeId, entry);
  }

  scopeIds(): string[] {
    return [...this.scopes.keys()];
  }

  has(scopeId: string): boolean {
    return this.scopes.has(scopeId);
  }

  state(scopeId: string, inputMode: CollaborationTeamTerminalInputMode, ownerDisplayName?: string): CollaborationTeamTerminalPresenceState {
    const entry = this.scopes.get(scopeId);
    if (!entry) return { inputMode, participants: [], marks: [] };
    const now = this.now();
    const counts = new Map<string, number>();
    for (const actorId of entry.connections.values()) counts.set(actorId, (counts.get(actorId) ?? 0) + 1);
    const participants: CollaborationTeamTerminalParticipant[] = [];
    const owner = entry.actors.get(entry.ownerId);
    // The owner hosts the terminal, so members always see who it belongs to.
    if (!owner) participants.push({ actorId: entry.ownerId, displayName: ownerDisplayName ?? "Owner", role: "owner", connections: 0 });
    for (const [actorId, actor] of entry.actors) {
      participants.push({
        actorId,
        displayName: actor.displayName,
        role: actor.role,
        connections: Math.min(counts.get(actorId) ?? 0, MAX_CONNECTIONS_SHOWN),
        ...(actor.typingAt && now - actor.typingAt <= TYPING_TTL_MS ? { typingAt: new Date(actor.typingAt).toISOString() } : {}),
      });
    }
    return {
      inputMode,
      participants: participants.slice(0, TEAM_TERMINAL_MAX_PARTICIPANTS),
      marks: entry.marks.slice(-TEAM_TERMINAL_MAX_MARKS_SENT),
    };
  }

  clearScope(scopeId: string): void {
    const entry = this.scopes.get(scopeId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.scopes.delete(scopeId);
  }

  close(): void {
    for (const scopeId of [...this.scopes.keys()]) this.clearScope(scopeId);
  }

  private entry(scopeId: string, ownerId: string): ScopeEntry {
    const existing = this.scopes.get(scopeId);
    if (existing) return existing;
    while (this.scopes.size >= this.maxScopes) {
      const oldest = this.scopes.keys().next().value;
      if (oldest === undefined) break;
      this.clearScope(oldest);
    }
    const created: ScopeEntry = { ownerId, connections: new Map(), actors: new Map(), marks: [], lastFlushAt: Number.NEGATIVE_INFINITY };
    this.scopes.set(scopeId, created);
    return created;
  }

  private schedule(scopeId: string, entry: ScopeEntry): void {
    if (entry.timer) return;
    const wait = entry.lastFlushAt + this.minIntervalMs - this.now();
    if (wait <= 0) {
      this.flush(scopeId, entry);
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.scopes.get(scopeId) === entry) this.flush(scopeId, entry);
    }, wait);
    entry.timer.unref?.();
  }

  private flush(scopeId: string, entry: ScopeEntry): void {
    entry.lastFlushAt = this.now();
    try {
      this.options.onChange(scopeId);
    } catch (error: unknown) {
      console.warn("[team-terminal-presence] change delivery failed", error instanceof Error ? error.name : "UnknownError");
    }
  }
}
