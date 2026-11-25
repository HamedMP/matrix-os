/**
 * Small per-org state lists for the Matrix Core installer (spec 2691, layer 6):
 * the agents an org was linked into, and skill namespaces still waiting to be
 * unlinked. Each is a JSON string array, replaced atomically (temp + rename).
 */
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Temp files for these lists; stale ones are swept by the installer. */
export const STATE_TEMP_PREFIX = ".targets-";

/** The recorded list, keeping only accepted entries; a missing or corrupt file is an empty list. */
export async function readStateList(orgRoot: string, file: string, accept: (value: string) => boolean, max: number): Promise<string[]> {
  try {
    const value = JSON.parse(await readFile(join(orgRoot, file), "utf8")) as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && accept(entry)).slice(0, max) : [];
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

/** Atomic replace; the temp file is removed if the write or rename fails. Keeps the newest `max` entries. */
export async function writeStateList(orgRoot: string, file: string, values: readonly string[], max: number): Promise<void> {
  const temporary = join(orgRoot, `${STATE_TEMP_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await writeFile(temporary, JSON.stringify([...new Set(values)].slice(-max)), { flag: "wx" });
    await rename(temporary, join(orgRoot, file));
  } catch (error: unknown) {
    await rm(temporary, { force: true });
    throw error;
  }
}
