import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { SystemIconMetadata } from "./icon-metadata.js";
const MAX_ICON_BYTES = 2 * 1024 * 1024;
async function boundedBytes(path: string | URL): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_ICON_BYTES) throw new Error("Icon unavailable");
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw new Error("Icon changed while reading");
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}
/** A selected filename is never proof that its owner-controlled bytes are default. */
export async function isUnmodifiedBundledIcon(homePath: string, icon: SystemIconMetadata): Promise<boolean> {
  const name = basename(icon.url.split("?")[0]!);
  if (!/^[a-zA-Z0-9_-]{1,64}\.(png|svg)$/.test(name)) return false;
  try {
    for (const path of [join(homePath,"system"), join(homePath,"system/icons")]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
    const [selected, bundled] = await Promise.all([
      boundedBytes(join(homePath,"system/icons",name)),
      boundedBytes(new URL(`../../../home/system/icons/${name}`, import.meta.url)),
    ]);
    return selected.equals(bundled);
  } catch (error) {
    if (!["ENOENT","ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) console.warn("[apps] Default icon classification unavailable",error instanceof Error ? error.name : "Unknown error");
    return false;
  }
}
