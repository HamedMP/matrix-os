import { mkdir } from "node:fs/promises";
import { join, dirname, extname, basename } from "node:path";
import { merge } from "node-diff3";
import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";

const TEXT_EXTENSIONS = new Set([
  ".md", ".ts", ".tsx", ".js", ".jsx", ".json", ".txt",
  ".css", ".html", ".yaml", ".yml", ".toml", ".xml",
  ".svg", ".sh", ".py", ".go", ".rs",
]);

export interface ConflictResult {
  merged: boolean;
  content: string;
  conflictPath?: string;
}

export interface TextConflictOptions {
  filePath: string;
  peerId: string;
  date?: Date;
}

export interface BinaryConflictOptions {
  filePath: string;
  syncRoot: string;
  remoteContent: Buffer;
  peerId: string;
  date?: Date;
}

export function isTextFile(filePath: string): boolean {
  const ext = extname(filePath);
  if (!ext) return false;
  return TEXT_EXTENSIONS.has(ext.toLowerCase());
}

export function generateConflictPath(
  filePath: string,
  peerId: string,
  date: Date,
): string {
  const safePeerId = peerId
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
  const dateStr = date.toISOString().split("T")[0]!;
  const ext = extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  const suffix = ` (conflict - ${safePeerId} - ${dateStr})`;
  return `${base}${suffix}${ext}`;
}

export async function resolveTextConflict(
  base: string,
  local: string,
  remote: string,
  options: TextConflictOptions,
): Promise<ConflictResult> {
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");

  const result = merge(localLines, baseLines, remoteLines);
  const content = result.result.join("\n");

  if (!result.conflict) {
    return { merged: true, content };
  }

  const conflictPath = generateConflictPath(
    options.filePath,
    options.peerId,
    options.date ?? new Date(),
  );

  return { merged: false, content, conflictPath };
}

export async function resolveBinaryConflict(
  options: BinaryConflictOptions,
): Promise<ConflictResult> {
  const conflictPath = generateConflictPath(
    options.filePath,
    options.peerId,
    options.date ?? new Date(),
  );

  const fullPath = join(options.syncRoot, conflictPath);
  await mkdir(dirname(fullPath), { recursive: true });
  const tmpPath = `${fullPath}.matrixos-${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, options.remoteContent, { flag: "wx" });
    await rename(tmpPath, fullPath);
  } catch (err: unknown) {
    await unlink(tmpPath).catch((cleanupErr: unknown) => {
      if (
        cleanupErr instanceof Error &&
        "code" in cleanupErr &&
        (cleanupErr as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      throw cleanupErr;
    });
    throw err;
  }

  return { merged: false, content: "", conflictPath };
}
