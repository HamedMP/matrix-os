/**
 * Reading a saved journal. The part is untrusted: every field is checked for
 * type, range and size, and the journal's rules (unique ids and cells, one
 * structural change or added sheet per sheet) are enforced. Anything that
 * does not pass makes the whole journal unreadable; the caller ignores it
 * with a warning.
 */

import type { FormulaErrorCode } from "../../api/formula.js";
import type { CellRange, CellValue } from "../../api/xlsx.js";
import { MAX_COLS, MAX_ROWS } from "../workbook/a1.js";
import type { RawCell } from "../workbook/internals.js";
import { features, linkedFeatures } from "./parse-features.js";
import { FormatError, fail, int, list, obj, text } from "./parse-util.js";
import {
  type AxisEntry,
  type BandSnapshot,
  JOURNAL_FORMAT_VERSION,
  type JournalData,
  type JournalEntry,
  MAX_CELL_MARKUP,
  MAX_DATE_TEXT,
  MAX_JOURNAL_TEXT,
  MAX_KEPT_MERGES,
  MAX_KEPT_NAMES,
  MAX_PENDING_CHANGES,
  MAX_PROPOSAL_TEXT,
  MAX_REWRITES,
  MAX_SNAPSHOT_CELLS,
  type NameRewrite,
  type ProposalRecord,
  type RewriteRecord,
} from "./types.js";

const ERROR_CODES: ReadonlySet<string> = new Set<FormulaErrorCode>(["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#N/A", "#NUM!", "#NULL!"]);
const MAX_COUNTER = 1_000_000_000;
const MAX_CELL_TEXT = 32_767;
const MAX_FORMULA_TEXT = 8_192;
const AXIS_KINDS = new Set(["insertRows", "deleteRows", "insertColumns", "deleteColumns"]);

function id(value: unknown, prefix: "p" | "c"): string {
  const s = text(value, 12, 2);
  if (!new RegExp(`^${prefix}[1-9][0-9]{0,9}$`).test(s)) fail();
  return s;
}

function sheetId(value: unknown): string {
  const s = text(value, 32, 1);
  if (!/^[0-9A-Za-z_-]+$/.test(s)) fail();
  return s;
}

function cellValue(value: unknown): CellValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : fail();
  if (typeof value === "string") return text(value, MAX_CELL_TEXT);
  const error = obj(value);
  if (error.kind !== "error" || typeof error.code !== "string" || !ERROR_CODES.has(error.code)) fail();
  return { kind: "error", code: error.code as FormulaErrorCode };
}

function raw(value: unknown): RawCell {
  const o = obj(value);
  const formula = o.formula === null ? null : text(o.formula, MAX_FORMULA_TEXT, 1);
  return { value: cellValue(o.value), formula, styleId: int(o.styleId, 0, MAX_COUNTER) };
}

function range(value: unknown): CellRange {
  const o = obj(value);
  const start = obj(o.start);
  const end = obj(o.end);
  const r: CellRange = {
    start: { row: int(start.row, 0, MAX_ROWS - 1), col: int(start.col, 0, MAX_COLS - 1) },
    end: { row: int(end.row, 0, MAX_ROWS - 1), col: int(end.col, 0, MAX_COLS - 1) },
  };
  if (r.start.row > r.end.row || r.start.col > r.end.col) fail();
  return r;
}

function proposal(value: unknown): ProposalRecord {
  const o = obj(value);
  return {
    id: id(o.id, "p"),
    author: text(o.author, MAX_PROPOSAL_TEXT, 1),
    date: text(o.date, MAX_DATE_TEXT, 1),
    label: text(o.label, MAX_PROPOSAL_TEXT),
    seq: int(o.seq, 1, MAX_COUNTER),
  };
}

function snapshot(value: unknown): BandSnapshot | null {
  if (value === null) return null;
  const o = obj(value);
  return {
    cells: list(o.cells, MAX_SNAPSHOT_CELLS).map((item) => {
      const c = obj(item);
      return { row: int(c.row, 0, MAX_ROWS - 1), col: int(c.col, 0, MAX_COLS - 1), raw: raw(c.raw) };
    }),
    // One size per deleted row or column at most, as `captureBand` keeps them.
    sizes: list(o.sizes, MAX_ROWS).map((item) => {
      const s = obj(item);
      const size = s.size;
      if (typeof size !== "number" || !Number.isFinite(size) || size < 0 || size > 409) fail();
      return { index: int(s.index, 0, MAX_ROWS - 1), size };
    }),
  };
}

function rewrites(value: unknown): RewriteRecord[] | null {
  if (value === null) return null;
  return list(value, MAX_REWRITES).map((item) => {
    const r = obj(item);
    return {
      sheet: sheetId(r.sheet),
      row: int(r.row, 0, MAX_ROWS - 1),
      col: int(r.col, 0, MAX_COLS - 1),
      before: text(r.before, MAX_FORMULA_TEXT, 1),
      after: text(r.after, MAX_FORMULA_TEXT, 1),
    };
  });
}

function names(value: unknown): NameRewrite[] {
  return list(value, MAX_KEPT_NAMES).map((item) => {
    const n = obj(item);
    return {
      name: text(n.name, 255, 1),
      scope: n.scope === null ? null : sheetId(n.scope),
      before: text(n.before, MAX_FORMULA_TEXT, 1),
      after: text(n.after, MAX_FORMULA_TEXT, 1),
    };
  });
}

function axisEntry(o: Record<string, unknown>, base: Omit<AxisEntry, "kind" | "index" | "count" | "snapshot" | "rewrites" | "names" | "merges" | "features" | "linked">, kind: AxisEntry["kind"]): AxisEntry {
  const limit = kind === "insertRows" || kind === "deleteRows" ? MAX_ROWS : MAX_COLS;
  const index = int(o.index, 0, limit - 1);
  const count = int(o.count, 1, limit - index);
  const shot = snapshot(o.snapshot);
  const isDelete = kind === "deleteRows" || kind === "deleteColumns";
  if (isDelete !== (shot !== null)) fail();
  let merges: AxisEntry["merges"] = null;
  if (o.merges !== null) {
    const m = obj(o.merges);
    merges = { before: list(m.before, MAX_KEPT_MERGES).map(range), after: list(m.after, MAX_KEPT_MERGES).map(range) };
  }
  // A journal written before deletions kept the features of the sheet has no such field.
  const kept = o.features === undefined || !isDelete ? null : features(o.features);
  // Written only when a deletion rewrote other sheets' features.
  const linked = o.linked === undefined || !isDelete ? [] : linkedFeatures(o.linked, sheetId);
  return { ...base, kind, index, count, snapshot: shot, rewrites: rewrites(o.rewrites), names: names(o.names), merges, features: kept, linked };
}

function entry(value: unknown): JournalEntry {
  const o = obj(value);
  const base = { id: id(o.id, "c"), proposalId: id(o.proposalId, "p"), seq: int(o.seq, 1, MAX_COUNTER), sheet: sheetId(o.sheet) };
  const kind = o.kind;
  if (kind === "cell") {
    // A journal written before cell changes kept markup has no such field.
    const oldMarkup = o.oldMarkup === undefined ? null : text(o.oldMarkup, MAX_CELL_MARKUP, 1);
    return { ...base, kind, row: int(o.row, 0, MAX_ROWS - 1), col: int(o.col, 0, MAX_COLS - 1), old: raw(o.old), next: raw(o.new), oldMarkup };
  }
  if (kind === "addSheet") return { ...base, kind, name: text(o.name, 31, 1) };
  if (kind === "renameSheet") return { ...base, kind, oldName: text(o.oldName, 31, 1), newName: text(o.newName, 31, 1) };
  if (typeof kind === "string" && AXIS_KINDS.has(kind)) return axisEntry(o, base, kind as AxisEntry["kind"]);
  return fail();
}

function checkRules(proposals: ProposalRecord[], entries: JournalEntry[]): void {
  const proposalIds = new Set(proposals.map((p) => p.id));
  if (proposalIds.size !== proposals.length) fail();
  const ids = new Set<string>();
  const seqs = new Set<number>(proposals.map((p) => p.seq));
  if (seqs.size !== proposals.length) fail();
  const cells = new Set<string>();
  const structural = new Set<string>();
  const renames = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id) || seqs.has(e.seq) || !proposalIds.has(e.proposalId)) fail();
    ids.add(e.id);
    seqs.add(e.seq);
    if (e.kind === "cell") {
      const key = `${e.sheet}!${e.row}:${e.col}`;
      if (cells.has(key)) fail();
      cells.add(key);
    } else if (e.kind === "renameSheet") {
      if (renames.has(e.sheet)) fail();
      renames.add(e.sheet);
    } else {
      if (structural.has(e.sheet)) fail();
      structural.add(e.sheet);
    }
  }
}

function numberAfter(ids: Iterable<string>): number {
  let max = 0;
  for (const value of ids) max = Math.max(max, Number(value.slice(1)));
  return max + 1;
}

/**
 * True when one entry, as `entryJson` writes it, would be read back: written
 * as JSON, within the size of a journal part and passing every check above.
 * The journal calls it before keeping a change, so that a saved journal is
 * never one the next open has to throw away.
 */
export function readableEntry(json: Record<string, unknown>): boolean {
  let source: string;
  try {
    source = JSON.stringify(json);
  } catch (error) {
    // Text longer than a string may be.
    if (error instanceof RangeError) return false;
    throw error;
  }
  if (source.length > MAX_JOURNAL_TEXT) return false;
  try {
    entry(JSON.parse(source));
    return true;
  } catch (error) {
    if (error instanceof FormatError) return false;
    throw error;
  }
}

export type ParseResult =
  | { ok: true; data: JournalData }
  | { ok: false; code: "journal_unreadable" | "journal_unsupported_version" };

/** Parses and checks the text of a journal part. */
export function parseJournal(source: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, code: "journal_unreadable" };
    throw error;
  }
  try {
    const top = obj(json);
    if (top.version !== JOURNAL_FORMAT_VERSION) {
      return { ok: false, code: typeof top.version === "number" ? "journal_unsupported_version" : "journal_unreadable" };
    }
    const proposals = list(top.proposals, MAX_PENDING_CHANGES).map(proposal);
    const entries = list(top.changes, MAX_PENDING_CHANGES).map(entry);
    checkRules(proposals, entries);
    let seqMax = 0;
    for (const item of [...proposals, ...entries]) seqMax = Math.max(seqMax, item.seq);
    return {
      ok: true,
      data: {
        nextProposal: Math.max(int(top.nextProposal, 1, MAX_COUNTER), numberAfter(proposals.map((p) => p.id))),
        nextChange: Math.max(int(top.nextChange, 1, MAX_COUNTER), numberAfter(entries.map((e) => e.id))),
        nextSeq: Math.max(int(top.nextSeq, 1, MAX_COUNTER), seqMax + 1),
        proposals,
        entries,
      },
    };
  } catch (error) {
    if (error instanceof FormatError) return { ok: false, code: "journal_unreadable" };
    throw error;
  }
}
