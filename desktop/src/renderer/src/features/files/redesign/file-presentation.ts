// How an entry looks in the redesigned Files: its kind label ("PDF", "Markdown"),
// its icon tile tone, and its meta line. Pure, so cards, rows and the details
// panel describe a file the same way.
import { formatBytes } from "../format";
import { kindForEntry, type FileKind } from "../file-kind";

export type TileTone = "neutral" | "info" | "warning" | "destructive";
export type FolderAccess = "own" | "shared" | "managed";

const NAMED_KINDS: Record<string, string> = {
  md: "Markdown",
  mdx: "MDX",
  txt: "Text",
  json: "JSON",
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  py: "Python",
  html: "HTML",
  css: "CSS",
  yml: "YAML",
  yaml: "YAML",
  csv: "CSV",
  pdf: "PDF",
  png: "PNG image",
  jpg: "JPEG image",
  jpeg: "JPEG image",
  gif: "GIF image",
  svg: "SVG image",
  webp: "WebP image",
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function kindLabel(entry: { name: string; type: "file" | "directory" }): string {
  if (entry.type === "directory") return "Folder";
  const extension = extensionOf(entry.name);
  if (!extension) return "File";
  return NAMED_KINDS[extension] ?? extension.toUpperCase();
}

/** PDF coral, archives gold, JSON and code info, everything else neutral. */
export function tileToneForFile(entry: { name: string; type: "file" | "directory" }): TileTone {
  if (entry.type === "directory") return "neutral";
  if (extensionOf(entry.name) === "pdf") return "destructive";
  const kind: FileKind = kindForEntry(entry);
  if (kind === "archive") return "warning";
  if (kind === "code") return "info";
  return "neutral";
}

export function tileToneForFolder(access: FolderAccess): TileTone {
  return access === "shared" ? "info" : "neutral";
}

/** "4 items" for folders, "PDF · 2.4 MB" for files. */
export function entryMeta(entry: { name: string; type: "file" | "directory"; sizeBytes?: number; children?: number }): string {
  if (entry.type === "directory") {
    if (typeof entry.children !== "number") return "Folder";
    return entry.children === 1 ? "1 item" : `${entry.children} items`;
  }
  const size = formatBytes(entry.sizeBytes);
  return size === "–" ? kindLabel(entry) : `${kindLabel(entry)} · ${size}`;
}

/** "15 folders, 3 files" for the page header. */
export function countSummary(entries: ReadonlyArray<{ type: "file" | "directory" }>): string {
  const folders = entries.filter((entry) => entry.type === "directory").length;
  const files = entries.length - folders;
  const part = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (folders === 0 && files === 0) return "Empty";
  if (folders === 0) return part(files, "file");
  if (files === 0) return part(folders, "folder");
  return `${part(folders, "folder")}, ${part(files, "file")}`;
}

/** File name without its extension, for selecting during rename. */
export function renameSelectionEnd(name: string, type: "file" | "directory"): number {
  if (type === "directory") return name.length;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}
