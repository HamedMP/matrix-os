import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

const MAX_FILE_BYTES = 100 * 1024 * 1024;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function destinationSnapshot(path: string): Promise<string | null> {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe download destination");
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** The caller passes only the path returned by a trusted native open dialog. */
export async function readDriveUploadFile(path: string): Promise<{ name: string; bytes: Uint8Array }> {
  if (!isAbsolute(path)) throw new Error("Invalid selected file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_FILE_BYTES) throw new Error("Invalid selected file");
    const bytes = new Uint8Array(info.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const part = await file.read(bytes, offset, bytes.byteLength - offset, offset);
      if (part.bytesRead < 1) throw new Error("Selected file changed");
      offset += part.bytesRead;
    }
    const extra = await file.read(new Uint8Array(1), 0, 1, offset);
    if (extra.bytesRead !== 0) throw new Error("Selected file changed");
    return { name: basename(path), bytes };
  } finally { await file.close(); }
}

/** The caller passes only the path returned by a trusted native save dialog. */
export async function saveDriveDownloadFile(destination: string, bytes: Uint8Array): Promise<void> {
  if (!isAbsolute(destination) || bytes.byteLength > MAX_FILE_BYTES) throw new Error("Invalid download destination");
  const before = await destinationSnapshot(destination);
  const temporary = join(dirname(destination), `.matrix-drive-${randomUUID()}.partial`);
  let file: FileHandle | null = null;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = null;
    if (await destinationSnapshot(destination) !== before) throw new Error("Download destination changed");
    if (before === null) await link(temporary, destination);
    else await rename(temporary, destination);
  } finally {
    if (file) await file.close().catch((error: unknown) =>
      console.warn("[organization-drive] temporary download close failed", error instanceof Error ? error.name : "UnknownError"));
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) console.warn("[organization-drive] temporary download cleanup failed", error instanceof Error ? error.name : "UnknownError");
    });
  }
}
