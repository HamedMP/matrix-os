/**
 * Spec 2710: presence, who-typed-what and the owner feed for team terminals.
 * Joins the terminal event registry (who is connected), the input modes (who
 * may type) and presence (bounded, content-free state). Collaborators get
 * `terminal.presence` frames only after `presence_subscribe`; the owner gets
 * the same state for every watched tab through `onOwnerEntries`.
 */
import {
  CollaborationTeamTerminalPresenceFrameSchema,
  TeamTerminalOwnerEntrySchema,
  type CollaborationParticipant,
  type TeamTerminalOwnerEntry,
} from "@matrix-os/contracts";
import { describeTerminalInput, TeamTerminalPresence } from "./team-terminal-presence.js";
import type { TeamTerminalInputModes } from "./team-terminal-input-mode.js";
import type { CollaborationTerminalConnectionObserver, CollaborationTerminalEventRegistry } from "./terminal-events.js";

const MAX_NAME_CACHE = 512;
const NAME_TTL_MS = 5 * 60_000;
const MAX_OWNER_LISTENERS = 8;
const CANONICAL_TERMINAL_ID = /^(tws_[a-f0-9]{32}):(tt_[a-f0-9]{32})$/;

type Registry = Pick<CollaborationTerminalEventRegistry, "observe" | "subscribePresence" | "liveTerminal" | "scopeForTerminal" | "sendPresence">;

export class TeamTerminalService implements CollaborationTerminalConnectionObserver {
  readonly presence: TeamTerminalPresence;
  private readonly names = new Map<string, { displayName: string; expiresAt: number }>();
  private readonly ownerListeners = new Set<(entries: TeamTerminalOwnerEntry[]) => void>();
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: {
    registry: Registry;
    inputModes: TeamTerminalInputModes;
    resolveParticipant(actorId: string): Promise<CollaborationParticipant>;
    now?: () => number;
    minIntervalMs?: number;
  }) {
    this.now = options.now ?? Date.now;
    this.presence = new TeamTerminalPresence({
      onChange: (scopeId) => this.publish(scopeId),
      now: this.now,
      ...(options.minIntervalMs !== undefined ? { minIntervalMs: options.minIntervalMs } : {}),
    });
    options.registry.observe(this);
  }

  joined(input: Parameters<CollaborationTerminalConnectionObserver["joined"]>[0]): void {
    void Promise.all([this.displayName(input.actorId), this.displayName(input.ownerId)]).then(([displayName]) => {
      if (this.closed || !this.options.registry.liveTerminal(input.scopeId)) return;
      this.presence.join(input.scopeId, input.connectionId, { actorId: input.actorId, displayName, role: input.role, ownerId: input.ownerId });
    });
  }

  left(scopeId: string, connectionId: string): void {
    this.presence.leave(scopeId, connectionId);
    // The last watcher left: the owner's view drops this tab too.
    if (!this.presence.has(scopeId)) this.notifyOwner();
  }

  roleChanged(scopeId: string, actorId: string, role: Parameters<CollaborationTerminalConnectionObserver["roleChanged"]>[2]): void {
    this.presence.updateRole(scopeId, actorId, role);
  }

  /** A collaborator opted into presence: they get the current state now. */
  subscribe(scopeId: string, connectionId: string): boolean {
    if (!this.options.registry.subscribePresence(connectionId)) return false;
    this.publish(scopeId);
    return true;
  }

  noteSharedInput(scopeId: string, actorId: string, data: string): void {
    const live = this.options.registry.liveTerminal(scopeId);
    if (!live) return;
    this.presence.noteInput(scopeId, actorId, { ...describeTerminalInput(data), outputSeq: live.sequence });
  }

  /** The owner typed in their own tab; it counts only while collaborators watch it. */
  noteOwnerInput(ref: { workspaceId: string; tabId: string }, data: string, actorId?: string): void {
    const scopeId = this.options.registry.scopeForTerminal(`${ref.workspaceId}:${ref.tabId}`);
    if (!scopeId) return;
    const live = this.options.registry.liveTerminal(scopeId);
    if (!live) return;
    // The tab socket's authenticated person; on an owner computer that is the owner.
    this.presence.noteInput(scopeId, actorId ?? live.ownerId, { ...describeTerminalInput(data), outputSeq: live.sequence });
  }

  inputModeChanged(scopeId: string): void {
    this.presence.changed(scopeId);
  }

  /** Bounded listener set for the owner's `/ws/terminal/events` feed. */
  onOwnerEntries(listener: (entries: TeamTerminalOwnerEntry[]) => void): () => void {
    if (this.ownerListeners.size >= MAX_OWNER_LISTENERS) throw new Error("Team terminal listener capacity reached");
    this.ownerListeners.add(listener);
    return () => { this.ownerListeners.delete(listener); };
  }

  ownerEntries(): TeamTerminalOwnerEntry[] {
    const entries: TeamTerminalOwnerEntry[] = [];
    for (const scopeId of this.scopesWatched()) {
      const entry = this.ownerEntry(scopeId);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  clearScope(scopeId: string): void {
    this.presence.clearScope(scopeId);
    this.notifyOwner();
  }

  close(): void {
    this.closed = true;
    this.options.registry.observe(undefined);
    this.presence.close();
    this.ownerListeners.clear();
    this.names.clear();
  }

  private scopesWatched(): string[] {
    return this.presence.scopeIds().filter((scopeId) => this.options.registry.liveTerminal(scopeId) !== null);
  }

  private ownerEntry(scopeId: string): TeamTerminalOwnerEntry | null {
    const live = this.options.registry.liveTerminal(scopeId);
    const match = live ? CANONICAL_TERMINAL_ID.exec(live.terminalId) : null;
    if (!live || !match) return null;
    const parsed = TeamTerminalOwnerEntrySchema.safeParse({
      ref: { workspaceId: match[1], tabId: match[2] },
      scopeId,
      ...this.presence.state(scopeId, this.options.inputModes.get(scopeId, live.incarnation), this.cachedName(live.ownerId)),
    });
    return parsed.success ? parsed.data : null;
  }

  private publish(scopeId: string): void {
    if (this.closed) return;
    const live = this.options.registry.liveTerminal(scopeId);
    if (!live) return;
    const frame = CollaborationTeamTerminalPresenceFrameSchema.safeParse({
      version: 1,
      type: "terminal.presence",
      scopeId,
      incarnation: live.incarnation,
      ...this.presence.state(scopeId, this.options.inputModes.get(scopeId, live.incarnation), this.cachedName(live.ownerId)),
    });
    if (!frame.success) {
      console.warn("[team-terminal] presence frame rejected", frame.error.name);
      return;
    }
    this.options.registry.sendPresence(scopeId, JSON.stringify(frame.data));
    this.notifyOwner();
  }

  private notifyOwner(): void {
    if (this.ownerListeners.size === 0) return;
    const entries = this.ownerEntries();
    for (const listener of this.ownerListeners) {
      try {
        listener(entries);
      } catch (error: unknown) {
        console.warn("[team-terminal] owner feed delivery failed", error instanceof Error ? error.name : "UnknownError");
      }
    }
  }

  private cachedName(actorId: string): string | undefined {
    const cached = this.names.get(actorId);
    return cached && cached.expiresAt > this.now() ? cached.displayName : undefined;
  }

  private async displayName(actorId: string): Promise<string> {
    const cached = this.cachedName(actorId);
    if (cached) return cached;
    let displayName = "Organization member";
    try {
      const participant = await this.options.resolveParticipant(actorId);
      if (participant.actorId === actorId) displayName = participant.displayName;
    } catch (error: unknown) {
      console.warn("[team-terminal] participant lookup failed", error instanceof Error ? error.name : "UnknownError");
    }
    this.names.delete(actorId);
    while (this.names.size >= MAX_NAME_CACHE) {
      const oldest = this.names.keys().next().value;
      if (oldest === undefined) break;
      this.names.delete(oldest);
    }
    this.names.set(actorId, { displayName, expiresAt: this.now() + NAME_TTL_MS });
    return displayName;
  }
}
