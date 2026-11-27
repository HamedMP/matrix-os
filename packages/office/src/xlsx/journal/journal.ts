/**
 * The change journal of one workbook: implements `WorkbookJournal`, the
 * object every proposal method of the workbook hands its call to.
 */

import type { CellChange, Proposal, ProposalOptions, ResolveChangesResult, SheetId } from "../../api/xlsx.js";
import { OfficeError } from "../../errors.js";
import type { WorkbookInternals, WorkbookJournal } from "../workbook/internals.js";
import { boolAttr, kid } from "../workbook/xml-util.js";
import { getAttr } from "../../xml/index.js";
import type { JournalContext } from "./context.js";
import { parseJournal } from "./parse.js";
import { writeJournalPart } from "./persist.js";
import { onMutation } from "./record.js";
import { acceptEntries, isStale, rejectEntries } from "./revert.js";
import { JournalStore } from "./store.js";
import { installWrappers, originalMethods } from "./structure.js";
import {
  type JournalChange,
  type JournalResolveResult,
  type JournalWarning,
  MAX_DATE_TEXT,
  MAX_JOURNAL_TEXT,
  MAX_PROPOSAL_TEXT,
} from "./types.js";
import { listChanges, listProposals } from "./view.js";

function readDate1904(internals: WorkbookInternals): boolean {
  const doc = internals.getPartXml(internals.workbookPartName);
  const properties = doc === null ? null : kid(doc.root, "workbookPr");
  return properties !== null && boolAttr(getAttr(properties, "date1904"), false);
}

function checkOptions(options: ProposalOptions): void {
  if (options === null || typeof options !== "object") throw new OfficeError("invalid_argument", "a proposal needs an author, a date and a label");
  const { author, date, label } = options;
  if (typeof author !== "string" || author.trim() === "" || author.length > MAX_PROPOSAL_TEXT) {
    throw new OfficeError("invalid_argument", "a proposal needs an author");
  }
  if (typeof date !== "string" || date === "" || date.length > MAX_DATE_TEXT) throw new OfficeError("invalid_argument", "a proposal needs a date");
  if (typeof label !== "string" || label.length > MAX_PROPOSAL_TEXT) throw new OfficeError("invalid_argument", "a proposal label is text");
}

export class ChangeJournal implements WorkbookJournal {
  readonly #ctx: JournalContext;

  constructor(internals: WorkbookInternals) {
    this.#ctx = {
      internals,
      workbook: internals.workbook,
      store: new JournalStore(),
      original: originalMethods(internals.workbook),
      self: this,
      date1904: readDate1904(internals),
      warnings: [],
      open: null,
      suppress: 0,
      capture: null,
      captureOverflow: false,
    };
    internals.onCellMutation((mutation) => onMutation(this.#ctx, mutation));
    installWrappers(this.#ctx);
  }

  /** Loads the text of a saved journal part. Unreadable content and stale changes become warnings. */
  load(source: string): void {
    const ctx = this.#ctx;
    if (source.length > MAX_JOURNAL_TEXT) {
      ctx.warnings.push({ code: "journal_too_large", changeId: null, sheet: null, row: null, col: null });
      return;
    }
    const parsed = parseJournal(source);
    if (!parsed.ok) {
      ctx.warnings.push({ code: parsed.code, changeId: null, sheet: null, row: null, col: null });
      return;
    }
    ctx.store.load(parsed.data);
    for (const entry of ctx.store.ordered()) {
      if (!isStale(ctx, entry)) continue;
      ctx.store.remove(entry);
      const cell = entry.kind === "cell";
      ctx.warnings.push({ code: "change_stale", changeId: entry.id, sheet: entry.sheet, row: cell ? entry.row : null, col: cell ? entry.col : null });
    }
    ctx.store.prune(null);
  }

  get warnings(): JournalWarning[] {
    return this.#ctx.warnings.map((warning) => ({ ...warning }));
  }

  beginProposal(options: ProposalOptions): string {
    const ctx = this.#ctx;
    checkOptions(options);
    if (ctx.open !== null) throw new OfficeError("invalid_operation", "a proposal is already open");
    ctx.open = ctx.store.newProposal({ author: options.author, date: options.date, label: options.label }).id;
    return ctx.open;
  }

  endProposal(): void {
    const ctx = this.#ctx;
    if (ctx.open === null) return;
    ctx.open = null;
    ctx.store.prune(null);
  }

  proposalOpen(): boolean {
    return this.#ctx.open !== null;
  }

  listProposals(): Proposal[] {
    return listProposals(this.#ctx);
  }

  listChanges(): CellChange[] {
    return this.listJournalChanges();
  }

  listJournalChanges(): JournalChange[] {
    return listChanges(this.#ctx);
  }

  acceptChanges(ids: readonly string[] | "all"): ResolveChangesResult {
    return acceptEntries(this.#ctx, ids);
  }

  rejectChanges(ids: readonly string[] | "all"): JournalResolveResult {
    return rejectEntries(this.#ctx, ids);
  }

  pendingChangeId(sheet: SheetId, row: number, col: number): string | null {
    return this.#ctx.store.cellAt(sheet, row, col)?.id ?? null;
  }

  pendingChangeCount(sheet: SheetId): number {
    return this.#ctx.store.countFor(sheet);
  }

  beforeSave(): void {
    writeJournalPart(this.#ctx);
  }
}
