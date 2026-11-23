/** Pure helpers of the Open dialog: which entries to show and where we are. */

import type { BridgeFileEntry } from "../../../_shared/matrix-os";
import { DOCX_EXTENSION, isBridgePath } from "../session/index";

/** Top-level folders the files bridge never lets an app read. */
const PROTECTED_ROOT_DIRS: ReadonlySet<string> = new Set(["system", "agents"]);

export function isDocxPath(path: string): boolean {
  return isBridgePath(path) && path.toLowerCase().endsWith(DOCX_EXTENSION);
}

/** Folders (except hidden and protected ones) and `.docx` files (except Word lock files). */
export function pickerEntries(dir: string, entries: readonly BridgeFileEntry[]): BridgeFileEntry[] {
  return entries.filter((entry) => {
    if (entry.name.startsWith(".")) return false;
    if (entry.kind === "dir") return !(dir === "" && PROTECTED_ROOT_DIRS.has(entry.name));
    return !entry.name.startsWith("~$") && entry.name.toLowerCase().endsWith(DOCX_EXTENSION);
  });
}

export function breadcrumbs(dir: string): Array<{ label: string; path: string }> {
  const crumbs = [{ label: "Home", path: "" }];
  if (dir === "") return crumbs;
  const segments = dir.split("/");
  segments.forEach((segment, index) => crumbs.push({ label: segment, path: segments.slice(0, index + 1).join("/") }));
  return crumbs;
}

export function parentOf(dir: string): string {
  const at = dir.lastIndexOf("/");
  return at < 0 ? "" : dir.slice(0, at);
}

/** The path for a folder and a name, with `.docx` added when missing; null when it cannot be used. */
export function savePath(folder: string, name: string): string | null {
  const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, "");
  let cleanName = name.trim();
  if (cleanName === "") return null;
  if (!cleanName.toLowerCase().endsWith(DOCX_EXTENSION)) cleanName += DOCX_EXTENSION;
  const path = cleanFolder === "" ? cleanName : `${cleanFolder}/${cleanName}`;
  return isDocxPath(path) ? path : null;
}
