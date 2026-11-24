/**
 * The cell change journal of the workbook engine.
 *
 * Importing this module registers the journal provider, so every handle
 * that `openXlsx`, `createXlsx` and `parseCsv` return supports
 * `beginProposal` … `rejectChanges` (`src/xlsx/index.ts` re-exports it).
 *
 * Beyond the `Workbook` contract:
 * - `listChanges()` returns {@link JournalChange} objects; use
 *   {@link listJournalChanges} for the typed list.
 * - Inserted and deleted rows and columns, added sheets and renamed sheets
 *   are recorded too, as changes of their own kind. Removing a sheet inside
 *   a proposal throws `invalid_operation`. Merges, sizes, frozen panes and
 *   defined names changed directly are not recorded.
 * - Rejecting a structural change or an added sheet also rejects every later
 *   change on that sheet. `rejectChanges` returns a {@link JournalResolveResult}
 *   whose `stale` lists changes left pending because the workbook no longer
 *   holds their recorded result.
 * - {@link getJournalWarnings} reports what was skipped when the file was read.
 */

import type { Workbook } from "../../api/xlsx.js";
import { OfficeError } from "../../errors.js";
import { type JournalProvider, type WorkbookInternals, getWorkbookInternals, setJournalProvider } from "../workbook/internals.js";
import { ChangeJournal } from "./journal.js";
import { JOURNAL_PART_NAME } from "./types.js";
import type { JournalChange, JournalWarning } from "./types.js";

export {
  JOURNAL_CONTENT_TYPE,
  JOURNAL_FORMAT_VERSION,
  JOURNAL_PART_NAME,
  JOURNAL_RELATIONSHIP_TYPE,
  MAX_PENDING_CHANGES,
  MAX_SNAPSHOT_CELLS,
} from "./types.js";
export type { JournalChange, JournalChangeKind, JournalResolveResult, JournalWarning, JournalWarningCode } from "./types.js";
export { ChangeJournal } from "./journal.js";

/** Builds the journal for a handle; `source` is the text of a saved journal part, or null. */
export function createChangeJournal(internals: WorkbookInternals, source: string | null): ChangeJournal {
  const journal = new ChangeJournal(internals);
  if (source !== null) journal.load(source);
  return journal;
}

export const changeJournalProvider: JournalProvider = {
  open: async (internals) => createChangeJournal(internals, await internals.readPartText(JOURNAL_PART_NAME)),
  create: (internals) => createChangeJournal(internals, null),
};

setJournalProvider(changeJournalProvider);

function journalOf(workbook: Workbook): ChangeJournal {
  const journal = getWorkbookInternals(workbook).getJournal();
  if (!(journal instanceof ChangeJournal)) throw new OfficeError("invalid_operation", "this workbook has no change journal");
  return journal;
}

/** Pending changes with their kind, display texts and stale flag. */
export function listJournalChanges(workbook: Workbook): JournalChange[] {
  return journalOf(workbook).listJournalChanges();
}

/** What was skipped when the workbook's journal was read: an unreadable part, or stale changes that were dropped. */
export function getJournalWarnings(workbook: Workbook): JournalWarning[] {
  return journalOf(workbook).warnings;
}
