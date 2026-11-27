import type { CollaborationTeamTerminalInputMode } from "@matrix-os/contracts";

const DEFAULT_MAX_ENTRIES = 256;

/**
 * Spec 2710: who may type into a team terminal right now. `shared` (the
 * default, never stored) accepts every editor; `owner` accepts only the
 * owner. The mode is bound to one terminal incarnation, so a replaced
 * process starts shared again. It lives in memory on purpose: after a
 * gateway restart every collaborator reconnects and the owner can take
 * control again, so a lost entry never blocks anyone wrongly.
 */
export class TeamTerminalInputModes {
  private readonly entries = new Map<string, { incarnation: string; terminalId: string }>();
  private readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 4_096) throw new RangeError("Invalid input mode capacity");
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  get(scopeId: string, incarnation: string): CollaborationTeamTerminalInputMode {
    return this.entries.get(scopeId)?.incarnation === incarnation ? "owner" : "shared";
  }

  set(scopeId: string, incarnation: string, mode: CollaborationTeamTerminalInputMode, terminalId = ""): void {
    this.entries.delete(scopeId);
    if (mode === "shared") return;
    // A live restriction is never dropped to make room: a new one is refused.
    // The cap is above the per-runtime shared-terminal cap (64).
    if (this.entries.size >= this.maxEntries) throw new RangeError("Input mode capacity reached");
    this.entries.set(scopeId, { incarnation, terminalId });
  }

  /** Every restriction, so an owner at capacity can drop the ones whose terminals ended. */
  restrictions(): Array<{ scopeId: string; incarnation: string; terminalId: string }> {
    return [...this.entries].map(([scopeId, entry]) => ({ scopeId, ...entry }));
  }

  clearScope(scopeId: string): void {
    this.entries.delete(scopeId);
  }

  clear(): void {
    this.entries.clear();
  }
}
