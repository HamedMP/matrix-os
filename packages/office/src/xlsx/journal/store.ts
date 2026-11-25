/**
 * The in-memory journal: proposals and pending entries with the indexes the
 * workbook asks for on every cell read (pending change of a cell, pending
 * count of a sheet). Size is bounded by {@link MAX_PENDING_CHANGES}; a
 * proposal record lives only while it is open or has pending entries.
 */

import type { SheetId } from "../../api/xlsx.js";
import { OfficeError } from "../../errors.js";
import { type CellEntry, type JournalData, type JournalEntry, MAX_PENDING_CHANGES, type ProposalRecord } from "./types.js";

function cellKey(sheet: SheetId, row: number, col: number): string {
  return `${sheet}!${row}:${col}`;
}

export class JournalStore {
  readonly proposals = new Map<string, ProposalRecord>();
  readonly entries = new Map<string, JournalEntry>();
  readonly #cells = new Map<string, CellEntry>();
  readonly #sheetCounts = new Map<SheetId, number>();
  #nextProposal = 1;
  #nextChange = 1;
  #nextSeq = 1;

  /** Loads saved data; the caller has validated it. */
  load(data: JournalData): void {
    this.#nextProposal = data.nextProposal;
    this.#nextChange = data.nextChange;
    this.#nextSeq = data.nextSeq;
    for (const proposal of data.proposals) this.proposals.set(proposal.id, proposal);
    for (const entry of [...data.entries].sort((a, b) => a.seq - b.seq)) this.add(entry);
  }

  snapshot(): JournalData {
    return {
      nextProposal: this.#nextProposal,
      nextChange: this.#nextChange,
      nextSeq: this.#nextSeq,
      proposals: [...this.proposals.values()],
      entries: this.ordered(),
    };
  }

  get size(): number {
    return this.entries.size;
  }

  /** Throws `limit_exceeded` when one more entry would not fit. */
  requireRoom(): void {
    if (this.entries.size >= MAX_PENDING_CHANGES) {
      throw new OfficeError("limit_exceeded", "the workbook has too many pending changes", {
        details: { maxPendingChanges: MAX_PENDING_CHANGES },
      });
    }
  }

  newProposal(fields: Omit<ProposalRecord, "id" | "seq">): ProposalRecord {
    const proposal: ProposalRecord = { id: `p${this.#nextProposal++}`, seq: this.#nextSeq++, ...fields };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  /** Id and order for a new entry. */
  nextIds(): { id: string; seq: number } {
    return { id: `c${this.#nextChange++}`, seq: this.#nextSeq++ };
  }

  add(entry: JournalEntry): void {
    this.entries.set(entry.id, entry);
    if (entry.kind === "cell") this.#cells.set(cellKey(entry.sheet, entry.row, entry.col), entry);
    this.#sheetCounts.set(entry.sheet, (this.#sheetCounts.get(entry.sheet) ?? 0) + 1);
  }

  remove(entry: JournalEntry): void {
    if (!this.entries.delete(entry.id)) return;
    if (entry.kind === "cell") {
      const key = cellKey(entry.sheet, entry.row, entry.col);
      if (this.#cells.get(key) === entry) this.#cells.delete(key);
    }
    const count = (this.#sheetCounts.get(entry.sheet) ?? 1) - 1;
    if (count <= 0) this.#sheetCounts.delete(entry.sheet);
    else this.#sheetCounts.set(entry.sheet, count);
  }

  cellAt(sheet: SheetId, row: number, col: number): CellEntry | undefined {
    return this.#cells.get(cellKey(sheet, row, col));
  }

  countFor(sheet: SheetId): number {
    return this.#sheetCounts.get(sheet) ?? 0;
  }

  /** Entries in recording order. */
  ordered(): JournalEntry[] {
    return [...this.entries.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Forgets proposals that have no pending entries, except `keep` (the open one). */
  prune(keep: string | null): void {
    const used = new Set<string>();
    for (const entry of this.entries.values()) used.add(entry.proposalId);
    for (const id of [...this.proposals.keys()]) {
      if (id !== keep && !used.has(id)) this.proposals.delete(id);
    }
  }

  pendingCount(proposalId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.proposalId === proposalId) count++;
    return count;
  }
}
