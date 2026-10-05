import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { createMemoryImportService } from "./service";
import { MEMORY_IMPORT_SCRIPT } from "./native-script";
import type { MemoryImportProvider } from "../../shared/memory-import-ipc";
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
          resolve(JSON.parse(stdout));
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
