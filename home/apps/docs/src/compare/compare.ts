/**
 * Compare the open document with another version.
 *
 * The open document is the original; the other `.docx` (picked from Files or
 * handed over as bytes) is the revised version. The engine's detailed
 * comparison builds a new document whose differences are tracked revisions;
 * it opens in the session as a new, unsaved document. The summary and the
 * answer to "Did anything substantive change?" are derived in code from the
 * engine's own classification, never by a model.
 */

import { compareDocxDetailed } from "../../../_shared/office-engine/docx/index";
import type { CompareSummary } from "../../../_shared/office-engine/docx/index";
import { isOfficeError } from "../../../_shared/office-engine/errors";
import type { MatrixOSFiles } from "../../../_shared/matrix-os";
import type { DocumentSession, OpenResult } from "../session/index";
import { fileName } from "../session/index";

/** Author of the comparison's revisions. */
export const COMPARE_AUTHOR = "Matrix Compare";

/** Largest file compared (the bridge limit). */
export const MAX_COMPARE_BYTES = 10 * 1024 * 1024;

export interface SubstantiveAnswer {
  /** True when any change alters what the document says. */
  changed: boolean;
  /** One sentence for the owner. */
  headline: string;
  /** The counts behind it. */
  detail: string;
}

export interface KindCount {
  label: string;
  count: number;
}

export type CompareFailure = "no_document" | "not_found" | "too_large" | "unreadable" | "unavailable" | "blocked" | "document_changed";

export type CompareFlowResult =
  | { status: "compared"; name: string; summary: CompareSummary; answer: SubstantiveAnswer; counts: KindCount[] }
  | { status: "failed"; reason: CompareFailure; message: string };

const FAILURE_MESSAGES: Record<CompareFailure, string> = {
  no_document: "Open a document first.",
  not_found: "That file could not be found.",
  too_large: "That file is too large to compare.",
  unreadable: "That file is not a Word document this app can read.",
  unavailable: "The comparison could not be made. Try again.",
  blocked: "Save or discard the changes to the open document before comparing.",
  document_changed: "Another document was opened while comparing. Compare again.",
};

function fail(reason: CompareFailure): CompareFlowResult {
  return { status: "failed", reason, message: FAILURE_MESSAGES[reason] };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Counts by kind for display, leaving out kinds with none. */
export function kindCounts(summary: CompareSummary): KindCount[] {
  const moves = Math.max(summary.counts.moveFrom, summary.counts.moveTo);
  return [
    { label: "Insertions", count: summary.counts.insert },
    { label: "Deletions", count: summary.counts.delete },
    { label: "Moves", count: moves },
    { label: "Formatting changes", count: summary.counts.format },
  ].filter((entry) => entry.count > 0);
}

/** "Did anything substantive change?", answered from the engine's classification. */
export function answerSubstantive(summary: CompareSummary): SubstantiveAnswer {
  if (summary.identical || summary.total === 0) {
    return { changed: false, headline: "No. The two versions are identical.", detail: "No differences were found." };
  }
  const parts: string[] = [];
  if (summary.paragraphs.inserted > 0) parts.push(`${plural(summary.paragraphs.inserted, "paragraph")} added`);
  if (summary.paragraphs.deleted > 0) parts.push(`${plural(summary.paragraphs.deleted, "paragraph")} removed`);
  if (summary.paragraphs.moved > 0) parts.push(`${plural(summary.paragraphs.moved, "paragraph")} moved`);
  if (summary.tableRows.inserted > 0) parts.push(`${plural(summary.tableRows.inserted, "table row")} added`);
  if (summary.tableRows.deleted > 0) parts.push(`${plural(summary.tableRows.deleted, "table row")} removed`);
  const structure = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  if (summary.substantive > 0) {
    const formatting = summary.formattingOnly > 0 ? ` and ${plural(summary.formattingOnly, "formatting-only change")}` : "";
    return {
      changed: true,
      headline: `Yes. ${plural(summary.substantive, "change")} alter${summary.substantive === 1 ? "s" : ""} the wording${structure}.`,
      detail: `${plural(summary.substantive, "substantive change")}${formatting}, ${plural(summary.total, "revision")} in all.`,
    };
  }
  return {
    changed: false,
    headline: "No. Only the formatting changed; the wording is the same.",
    detail: `${plural(summary.formattingOnly, "formatting-only change")}, no change to the text.`,
  };
}

export interface CompareDeps {
  session: DocumentSession;
  /**
   * The `documentKey` of the document being compared, taken before any slow
   * step (such as reading a device file). Default: the document open when the
   * flow starts. The result is dropped when another document is open by then.
   */
  documentKey?: number;
  files?: Pick<MatrixOSFiles, "read">;
  now?: () => Date;
  log?: (message: string, error: unknown) => void;
}

/** Compares the open document with the `.docx` at a home-relative path. */
export async function compareWithFile(deps: CompareDeps, path: string): Promise<CompareFlowResult> {
  if (deps.session.document === null) return fail("no_document");
  if (deps.files === undefined) return fail("unavailable");
  const documentKey = deps.documentKey ?? deps.session.getState().documentKey;
  let bytes: Uint8Array;
  try {
    const content = await deps.files.read(path);
    bytes = content.bytes;
  } catch (error) {
    (deps.log ?? logDefault)("docs compare: could not read the other version", error instanceof Error ? error.name : error);
    const code = (error as { name?: string; code?: string } | null)?.name === "BridgeFileError" ? (error as { code?: string }).code : null;
    return fail(code === "not_found" ? "not_found" : code === "too_large" ? "too_large" : "unavailable");
  }
  return compareWithBytes({ ...deps, documentKey }, bytes, fileName(path));
}

function logDefault(message: string, detail: unknown): void {
  console.warn(message, detail);
}

/** Compares the open document with another version given as bytes. */
export async function compareWithBytes(deps: CompareDeps, bytes: Uint8Array, otherName: string): Promise<CompareFlowResult> {
  const { session } = deps;
  const documentKey = deps.documentKey ?? session.getState().documentKey;
  const changed = () => session.getState().documentKey !== documentKey;
  if (changed()) return fail("document_changed");
  const original = session.document;
  if (original === null) return fail("no_document");
  if (bytes.byteLength > MAX_COMPARE_BYTES) return fail("too_large");
  const log = deps.log ?? logDefault;
  const now = (deps.now ?? (() => new Date()))();
  let result;
  try {
    result = await compareDocxDetailed(original, bytes, { author: COMPARE_AUTHOR, date: now.toISOString() });
  } catch (error) {
    log("docs compare: the comparison failed", isOfficeError(error) ? error.code : error instanceof Error ? error.name : error);
    if (isOfficeError(error) && ["not_a_zip", "unsupported_format", "corrupt_package", "malformed_xml", "zip_limit_exceeded"].includes(error.code)) {
      return fail("unreadable");
    }
    return fail("unavailable");
  }
  // The owner may have opened or closed a document while the engine worked.
  if (changed()) return fail("document_changed");
  const name = comparisonName(session.getState().name, otherName);
  let opened: OpenResult;
  try {
    opened = await session.adopt(result.document, { name, dirty: true });
  } catch (error) {
    log("docs compare: could not open the comparison", error instanceof Error ? error.name : error);
    return fail("unavailable");
  }
  if (opened.status !== "opened") return fail(opened.status === "blocked" ? "blocked" : "unavailable");
  return { status: "compared", name, summary: result.summary, answer: answerSubstantive(result.summary), counts: kindCounts(result.summary) };
}

/** Working name of the comparison document, e.g. `contract compared with contract-v2.docx`. */
export function comparisonName(current: string, other: string): string {
  const base = current.replace(/\.docx$/i, "") || "Document";
  const name = `${base} compared with ${other.replace(/\.docx$/i, "")}.docx`;
  return name.length > 200 ? `${name.slice(0, 195)}.docx` : name;
}
