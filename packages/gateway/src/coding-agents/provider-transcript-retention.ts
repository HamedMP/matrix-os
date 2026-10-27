import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_ORPHAN_FILES = 200;

/** The store serializes each deletion with durable reference changes; watches are rechecked at unlink. */
export async function cleanupProviderTranscripts(input: {
  directory: string; now: number; hasWatcher: (sessionId: string) => boolean;
  removeUnreferenced?: (sessionId: string, remove: () => Promise<boolean>) => Promise<boolean>;
}) {
  if (!input.removeUnreferenced) return;
  let entries;
  try { entries = await readdir(input.directory, { withFileTypes: true }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const sessionId = entry.name.slice(0, -6);
    if (!/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId) || input.hasWatcher(sessionId)) continue;
    const path = join(input.directory, entry.name);
    const info = await lstat(path);
    if (info.isFile() && !info.isSymbolicLink()) files.push({ path, sessionId, info });
  }
  files.sort((left, right) => left.info.mtimeMs - right.info.mtimeMs);
  for (const [index, file] of files.entries()) {
    if (file.info.mtimeMs > input.now - RETENTION_MS && index >= files.length - MAX_ORPHAN_FILES) continue;
    try {
      await input.removeUnreferenced(file.sessionId, async () => {
        if (input.hasWatcher(file.sessionId)) return false;
        const current = await lstat(file.path);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== file.info.dev || current.ino !== file.info.ino
          || input.hasWatcher(file.sessionId)) return false;
        await rm(file.path, { force: true });
        return true;
      });
    } catch (error) {
      console.warn("[coding-agents] Transcript retention deferred", error instanceof Error ? error.name : "UnknownError");
      return;
    }
  }
}
