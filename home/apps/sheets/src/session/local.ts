/**
 * Documents from this computer and files for download.
 *
 * A workbook opened from a local file has no Matrix path: it is a session
 * with `source: "local"`, autosave off, and no recent-files entry. Saving it
 * means downloading the updated file under the same name
 * (`exportSessionFile`, then `session.markDownloaded()`); `session.saveAs`
 * to a Matrix path makes it a normal Matrix document.
 */

import { type LoadedWorkbook, SheetSessionError, fileName, formatOfPath, loadWorkbook } from "./file-io";
import { failure } from "./results";
import { SheetSession } from "./session";
import type { SessionDeps, SessionFailure, SheetFileFormat } from "./types";

const MIME_TYPES: Record<SheetFileFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
};

const MAX_NAME = 200;

/** A plain file name without folders or characters file systems refuse. */
function cleanName(name: string): string {
  return fileName(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"|?*]/g, "_").slice(-MAX_NAME);
}

/** Opens the bytes of a file chosen on this computer. Throws {@link SheetSessionError}. */
export async function openLocalSheetSession(deps: SessionDeps, name: string, bytes: Uint8Array): Promise<SheetSession> {
  const clean = cleanName(name);
  const format = formatOfPath(clean);
  if (format === null || clean.startsWith(".")) throw new SheetSessionError("unsupported");
  const loaded: LoadedWorkbook = await loadWorkbook(bytes, format);
  return new SheetSession(deps, loaded, { path: null, format, version: null }, { name: clean, source: "local" });
}

export type ExportedFile = { ok: true; name: string; bytes: Uint8Array; mimeType: string } | SessionFailure;

/**
 * The workbook as a file to download: in its own format and name, or as a
 * copy in another format (`data.csv` gives `data.xlsx`). A CSV or TSV file
 * cannot hold changes that wait for review, so that export is refused.
 */
export async function exportSessionFile(session: SheetSession, format: SheetFileFormat = session.getState().format): Promise<ExportedFile> {
  const state = session.getState();
  if (format !== "xlsx" && session.workbook.listChanges().length > 0) return failure(new SheetSessionError("review_pending"));
  const stem = state.name.replace(/\.(xlsx|csv|tsv)$/i, "") || "Workbook";
  try {
    const bytes = await session.serialize(format);
    return { ok: true, name: `${stem}.${format}`, bytes, mimeType: MIME_TYPES[format] };
  } catch (error: unknown) {
    return failure(error);
  }
}
