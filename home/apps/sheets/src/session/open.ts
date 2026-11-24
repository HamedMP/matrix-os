/** Making sessions: from a file in the owner's home, or new and empty. */

import { createXlsx } from "./engine";
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

/** A new, empty workbook that has no file yet. `saveAs` gives it one. */
export function createSheetSession(deps: SessionDeps, options: { name?: string } = {}): SheetSession {
  const loaded: LoadedWorkbook = { workbook: createXlsx(), csv: null };
  return new SheetSession(deps, loaded, { path: null, format: "xlsx", version: null }, { name: options.name });
}
