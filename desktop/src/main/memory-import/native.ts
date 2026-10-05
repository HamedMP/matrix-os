import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { createMemoryImportService } from "./service";
import { MEMORY_IMPORT_SCRIPT } from "./native-script";
import {
  MemoryImportBatchSchema,
  type MemoryImportProvider,
  type MemoryImportBatch,
} from "../../shared/memory-import-ipc";
import { z } from "zod/v4";
const mailPreviewSchema = z.object({
  records: MemoryImportBatchSchema.shape.records,
  warnings: MemoryImportBatchSchema.shape.warnings,
}).strict();
/** Preserve source identity across edits; payload hashes only detect ambiguous copies in this bounded preview. */
export function normalizeNativeMailPreview(input: unknown): MemoryImportBatch {
  const value = mailPreviewSchema.parse(input);
  if (value.records.some(r => r.kind !== "email") ||
      value.records.reduce((n, r) => n + r.content.length, 0) > 1000000)
    throw Error("Invalid mail preview");
  const entries: { record: MemoryImportBatch["records"][number]; fingerprint: string; conflicted: boolean }[] = [];
  let duplicate = false;
  for (const record of value.records) {
    const fingerprint = createHash("sha256").update(JSON.stringify([
      record.externalId, record.title, record.metadata?.sender ?? "",
      record.metadata?.recipient ?? "", record.content,
    ])).digest("hex");
    const existing = entries.find(entry => entry.record.externalId === record.externalId);
    if (!existing) entries.push({ record, fingerprint, conflicted: false });
    else if (existing.fingerprint === fingerprint) duplicate = true;
    else existing.conflicted = true;
  }
  const warnings = [...value.warnings];
  const warn = (message: string) => {
    if (warnings.length === 20) warnings[19] = `${message} Some other import warnings are not shown.`;
    else warnings.push(message);
  };
  if (duplicate) warn("Duplicate message copies were omitted.");
  // Mail exposes no immutable variant identity for a conflicting Message-ID.
  // Omit every candidate for that identity rather than choose an arbitrary copy.
  if (entries.some(entry => entry.conflicted)) warn("Messages sharing an identity but different contents were omitted. Narrow your selection or use a normalized export with distinct stable IDs before importing them.");
  const records = entries.filter(entry => !entry.conflicted).map(entry => entry.record);
  return MemoryImportBatchSchema.parse({ records, warnings });
}
export async function readMemoryExport(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw Error("Invalid export file");
    const buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await file.stat();
    if (total !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw Error("Export changed while reading");
    return {
      name: basename(path),
      content: buffer.subarray(0, total).toString("utf8"),
      sourceIdentity: createHash("sha256").update(path).digest("hex"),
    };
  } finally {
    await file.close();
  }
}
export function runNativeMemoryRead(
  provider: MemoryImportProvider,
  action: "inventory" | "preview",
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        MEMORY_IMPORT_SCRIPT,
        JSON.stringify({ provider, action, input }),
      ],
      { signal, timeout: 30000, maxBuffer: 3 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const code = String(stderr).includes("-1743")
            ? "permission_denied"
            : error.killed
              ? "timeout"
              : "unavailable";
          reject(
            Object.assign(new Error("Native source read failed"), { code }),
          );
          return;
        }
        try {
          const value: unknown = JSON.parse(stdout);
          resolve(provider === "mail" && action === "preview" ? normalizeNativeMailPreview(value) : value);
        } catch {
          reject(
            Object.assign(new Error("Native source response invalid"), {
              code: "unavailable",
            }),
          );
        }
      },
    );
  });
}
export function createDefaultMemoryImportService({
  chooseFile,
  identity,
}: {
  chooseFile: () => Promise<string | null>;
  identity: () => string | null;
}) {
  return createMemoryImportService({
    chooseFile,
    identity,
    readFile: readMemoryExport,
    native: runNativeMemoryRead,
  });
}
