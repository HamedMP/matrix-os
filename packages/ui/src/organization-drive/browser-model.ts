import type { OrganizationDriveFile } from "@matrix-os/contracts";
export type DriveBrowserEntry = { kind: "folder"; path: string; name: string; fileCount: number } | { kind: "file"; path: string; name: string; file: OrganizationDriveFile };
/** Derive only the bounded, authorized listing; searching does not imply an exhaustive drive search. */
export function driveBrowserEntries(files: readonly OrganizationDriveFile[], folder: string, query: string, sort: "name" | "modified"): DriveBrowserEntry[] {
  const prefix = folder ? `${folder}/` : "";
  const search = query.trim().toLocaleLowerCase();
  const entries: DriveBrowserEntry[] = [];
  const folders = new Map<string, Extract<DriveBrowserEntry, {kind: "folder"}>>();
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const relative = file.path.slice(prefix.length);
    if (search) {
      if (relative.toLocaleLowerCase().includes(search)) entries.push({ kind: "file", path: file.path, name: relative.split("/").at(-1)!, file });
      continue;
    }
    const segments = relative.split("/");
    if (segments.length === 1) entries.push({ kind: "file", path: file.path, name: relative, file });
    else {
      const path = `${prefix}${segments[0]}`;
      const existing = folders.get(path);
      if (existing) existing.fileCount += 1;
      else folders.set(path, {kind: "folder", path, name: segments[0]!, fileCount: 1});
    }
  }
  // The map cannot exceed the bounded input listing and is discarded after each derivation.
  return [...folders.values(), ...entries].sort((a, c) => {
    if (a.kind !== c.kind) return a.kind === "folder" ? -1 : 1;
    if (sort === "modified" && a.kind === "file" && c.kind === "file") {
      const delta = Date.parse(c.file.updatedAt) - Date.parse(a.file.updatedAt);
      if (delta) return delta;
    }
    return a.path.localeCompare(c.path, "en", {numeric: true});
  });
}
export function driveFileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes < 1_000_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${(bytes / 1_000_000_000_000).toFixed(1)} TB`;
}
