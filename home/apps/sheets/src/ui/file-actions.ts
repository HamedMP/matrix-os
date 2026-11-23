/** Save, save as, save a copy and CSV download, with messages safe to show. */
import type { SheetGridController } from "../grid";
import { exportSessionFile, fileName, formatOfPath, isValidFilePath } from "../session";
import { toCsv } from "../session/engine";
import type { SheetSession } from "../session/session";
import type { SaveOutcome, SheetFileFormat } from "../session/types";
import { logFailure } from "./bridge";

export type Notify = (message: string, tone?: "info" | "success" | "warning" | "danger") => void;
/** Hands the browser bytes to save on this computer (`downloadBytes` from the UI kit). */
export type Download = (name: string, bytes: Uint8Array, mimeType: string) => void;

const NO_DOWNLOAD = "This window cannot download files. Save a copy to Matrix instead.";

/**
 * Downloads the workbook: in its own format for a local document's Save,
 * or as a copy in `format`. False when nothing was downloaded.
 */
export async function downloadWorkbook(session: SheetSession, download: Download, notify: Notify, format?: SheetFileFormat): Promise<boolean> {
  const file = await exportSessionFile(session, format);
  if (!file.ok) {
    notify(file.message, "danger");
    return false;
  }
  try {
    download(file.name, file.bytes, file.mimeType);
  } catch (error: unknown) {
    logFailure("download failed", error);
    notify(NO_DOWNLOAD, "danger");
    return false;
  }
  return true;
}

export type SaveResult = "saved" | "needs-path" | "failed";

/**
 * Saves the document where it belongs: a Matrix file is written to its
 * path, a local document is downloaded under its own name and then counts
 * as saved, and a new workbook asks for a path (`needs-path`). A failure is
 * shown through `notify` and leaves the document as it is.
 */
export async function saveDocument(session: SheetSession, download: Download, notify: Notify): Promise<SaveResult> {
  const state = session.getState();
  if (state.source === "local") {
    if (!(await downloadWorkbook(session, download, notify))) return "failed";
    session.markDownloaded();
    notify(`Downloaded ${state.name} to this computer.`, "success");
    return "saved";
  }
  if (state.path === null) return "needs-path";
  const outcome = await session.save();
  if (outcome.status === "saved" || outcome.status === "unchanged") return "saved";
  notify(describeSave(outcome)?.message ?? "The workbook could not be saved.", outcome.status === "conflict" ? "warning" : "danger");
  return "failed";
}

/** Describes a save outcome for a toast; null when the title bar already says enough. */
export function describeSave(outcome: SaveOutcome, verb = "Saved"): { message: string; tone: "success" | "warning" | "danger" } | null {
  switch (outcome.status) {
    case "saved":
      return { message: `${verb} as ${fileName(outcome.path)}.`, tone: "success" };
    case "unchanged":
    case "superseded":
      return null;
    case "conflict":
      return { message: "The file changed on disk. Reload it or save a copy.", tone: "warning" };
    case "error":
      return { message: outcome.message, tone: "danger" };
  }
}

/** Saves to the file's own path. Text still in the cell editor is stored first. */
export async function saveNow(session: SheetSession, controller: SheetGridController, notify: Notify): Promise<void> {
  controller.commitEdit();
  const outcome = await session.save();
  if (outcome.status === "saved" || outcome.status === "unchanged") return;
  const text = describeSave(outcome);
  if (text !== null) notify(text.message, text.tone);
}

export async function saveCopyNow(session: SheetSession, controller: SheetGridController, notify: Notify): Promise<void> {
  controller.commitEdit();
  const outcome = await session.saveCopy();
  const text = describeSave(outcome, "Saved a copy");
  if (text !== null) notify(outcome.status === "saved" ? `${text.message} You are now editing the copy.` : text.message, text.tone);
}

/** The path of a .csv or .tsv file with the .xlsx extension, numbered when that name is taken. */
export function workbookPathFor(path: string, attempt = 1): string {
  const stem = path.replace(/\.(csv|tsv)$/i, "");
  return attempt <= 1 ? `${stem}.xlsx` : `${stem} (${attempt}).xlsx`;
}

/** Saves a CSV or TSV file as a workbook beside it, which keeps pending changes for review, and continues there. */
export async function saveAsWorkbookNow(session: SheetSession, controller: SheetGridController, notify: Notify): Promise<void> {
  controller.commitEdit();
  const path = session.getState().path;
  if (path === null) return;
  let outcome: SaveOutcome = { status: "unchanged" };
  for (let attempt = 1; attempt <= 20; attempt++) {
    outcome = await session.saveAs(workbookPathFor(path, attempt));
    if (outcome.status !== "error" || outcome.code !== "exists") break;
  }
  const text = describeSave(outcome);
  if (text !== null) notify(outcome.status === "saved" ? `${text.message} Suggested changes are kept for review.` : text.message, text.tone);
}

/** Checks a folder and a file name typed in the save dialog; returns the path or a message. */
export function buildSavePath(folder: string, name: string): { ok: true; path: string } | { ok: false; message: string } {
  const dir = folder.trim().replace(/^\/+|\/+$/g, "");
  let file = name.trim();
  if (file === "") return { ok: false, message: "Type a file name." };
  if (file.includes("/")) return { ok: false, message: "A file name cannot contain a slash." };
  if (formatOfPath(file) === null) file = `${file}.xlsx`;
  const path = dir === "" ? file : `${dir}/${file}`;
  if (!isValidFilePath(path)) return { ok: false, message: "That folder or file name cannot be used." };
  return { ok: true, path };
}

const MAX_DOWNLOAD_NAME = 200;

/** The CSV of the active sheet, and a file name for it. */
export function csvOfActiveSheet(session: SheetSession): { name: string; text: string } {
  const state = session.getState();
  const stem = state.name.replace(/\.(xlsx|csv|tsv)$/i, "") || "Sheet";
  const sheetName = session.sheet(state.activeSheetId).name;
  const many = session.sheets().filter((sheet) => sheet.state === "visible").length > 1;
  const name = `${many ? `${stem} - ${sheetName}` : stem}`.replace(/[\\/:*?"<>|]/g, "_").slice(0, MAX_DOWNLOAD_NAME);
  return { name: `${name}.csv`, text: toCsv(session.workbook, state.activeSheetId) };
}

/** Downloads the active sheet as CSV, with a byte-order mark so spreadsheet programs read it as UTF-8. */
export function downloadActiveSheetCsv(session: SheetSession, download: Download, notify: Notify): boolean {
  const csv = csvOfActiveSheet(session);
  const body = new TextEncoder().encode(csv.text);
  const bytes = new Uint8Array(body.length + 3);
  bytes.set([0xef, 0xbb, 0xbf], 0);
  bytes.set(body, 3);
  try {
    download(csv.name, bytes, "text/csv");
    return true;
  } catch (error: unknown) {
    logFailure("download failed", error);
    notify(NO_DOWNLOAD, "danger");
    return false;
  }
}
