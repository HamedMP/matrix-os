import { merge } from "node-diff3";

export const TEXT_EXTENSIONS = new Set([
  ".md", ".ts", ".json", ".txt", ".jsx", ".tsx",
  ".css", ".html", ".yaml", ".toml", ".xml",
  ".svg", ".sh", ".py", ".go", ".rs",
]);

export interface ConflictDetectionInput {
  localHash: string;
  remoteHash: string;
  baseHash: string;
}

export function detectConflict(input: ConflictDetectionInput): boolean {
  const { localHash, remoteHash, baseHash } = input;

  // Both sides changed from the base, and they changed to different values
  const localChanged = localHash !== baseHash;
  const remoteChanged = remoteHash !== baseHash;
  const diverged = localHash !== remoteHash;

  return localChanged && remoteChanged && diverged;
}

export interface MergeResult {
  conflict: boolean;
  merged: string;
}

export function mergeText(
  localContent: string,
  baseContent: string,
  remoteContent: string,
): MergeResult {
  const result = merge(localContent, baseContent, remoteContent);
  return {
    conflict: result.conflict,
    merged: result.result.join("\n"),
  };
}

export function createConflictCopyPath(
  originalPath: string,
  peerId: string,
  date: Date,
): string {
  const safePeerId = peerId
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
  const dateStr = date.toISOString().split("T")[0]!;
  const lastDot = originalPath.lastIndexOf(".");
  const lastSlash = originalPath.lastIndexOf("/");

  // Only treat as extension if the dot is after the last slash (i.e., in the filename)
  const hasExtension = lastDot > lastSlash + 1;

  if (hasExtension) {
    const base = originalPath.slice(0, lastDot);
    const ext = originalPath.slice(lastDot);
    return `${base} (conflict - ${safePeerId} - ${dateStr})${ext}`;
  }

  return `${originalPath} (conflict - ${safePeerId} - ${dateStr})`;
}

export function isTextFile(path: string): boolean {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return false;

  const ext = path.slice(lastDot).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}
