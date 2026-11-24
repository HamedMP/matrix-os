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
  private readonly entries = new Map<string, string>();
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
    return this.entries.get(scopeId) === incarnation ? "owner" : "shared";
  }

  set(scopeId: string, incarnation: string, mode: CollaborationTeamTerminalInputMode): void {
    this.entries.delete(scopeId);
    if (mode === "shared") return;
    // The cap is above the per-runtime shared-terminal cap (64), so eviction
    // only bounds memory; an evicted entry reads as shared.
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(scopeId, incarnation);
  }

  clearScope(scopeId: string): void {
    this.entries.delete(scopeId);
  }

  clear(): void {
    this.entries.clear();
  }
}
