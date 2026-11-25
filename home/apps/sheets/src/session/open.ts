/** Making sessions: from a file in the owner's home, or new and empty. */

import { type Workbook, createXlsx } from "./engine";
import { type LoadedWorkbook, SheetSessionError, formatOfPath, loadWorkbook, toSessionError } from "./file-io";
import { SheetSession } from "./session";
import type { SessionDeps } from "./types";

/** Opens a file from the owner's home. Throws {@link SheetSessionError}; the file is never written when opening fails. */
export async function openSheetSession(deps: SessionDeps, path: string): Promise<SheetSession> {
  const format = formatOfPath(path);
  if (format === null) throw new SheetSessionError("unsupported");
  let content;
  try {
    content = await deps.files.read(path);
  } catch (error: unknown) {
    throw toSessionError(error);
  }
  const loaded = await loadWorkbook(content.bytes, format);
  const session = new SheetSession(deps, loaded, { path: content.path, format, version: content.version });
  void session.recents.touch(content.path);
  return session;
}

/** A new workbook that has no file yet: empty, or the one given (a template). `saveAs` gives it a file. */
export function createSheetSession(deps: SessionDeps, options: { name?: string; workbook?: Workbook } = {}): SheetSession {
  const loaded: LoadedWorkbook = { workbook: options.workbook ?? createXlsx(), csv: null };
  return new SheetSession(deps, loaded, { path: null, format: "xlsx", version: null }, { name: options.name });
}
