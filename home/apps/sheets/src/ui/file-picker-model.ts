/** Which entries the file picker lists. */
import type { BridgeFileEntry } from "../../../_shared/matrix-os";
import { formatOfPath } from "../session";

/** Folders, then spreadsheet files, as the bridge sorts them. */
export function pickable(entries: readonly BridgeFileEntry[]): BridgeFileEntry[] {
  return entries.filter((entry) => entry.kind === "dir" || formatOfPath(entry.path) !== null);
}
