import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
const Lease = z.strictObject({ pid: z.number().int().positive(), nonce: z.uuid() });
const unavailable = () => new Error("Preview profile is in use or unavailable");
const code = (error: unknown, value: string) => error instanceof Error && "code" in error && error.code === value;
/** One process/cleanup owner at a time. A dead owner is recoverable; an unknown
 * or reused PID is refused. Never signal a PID from a file. */
export async function claimPreviewProfile(root: string) {
  const owner = await lstat(root);
  if (!owner.isDirectory() || owner.isSymbolicLink() || owner.uid !== process.getuid?.() || owner.mode & 0o077 || await realpath(root) !== root) throw unavailable();
  const path = join(root, ".preview-active.json");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600), stat = await file.stat();
      try { await file.writeFile(JSON.stringify(Lease.parse({ pid: process.pid, nonce: randomUUID() }))); }
      catch (error: unknown) { await file.close(); await unlink(path); throw error; }
      let released = false;
      return { async release() {
        if (released) return; released = true; await file.close();
        try { const current = await lstat(path); if (current.ino === stat.ino && current.dev === stat.dev && !current.isSymbolicLink()) await unlink(path); }
        catch (error: unknown) { if (!code(error, "ENOENT")) throw error; }
      } };
    } catch (error: unknown) { if (!code(error, "EEXIST")) throw error; }
    // Serialize stale-owner recovery. A crash during this tiny recovery window
    // leaves a conservative manual-recovery blocker, never an unlocked profile.
    const recoveryPath = join(root, ".preview-recovery.lock");
    const recovery = await open(recoveryPath, "wx", 0o600);
    try {
      const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let stale: Awaited<ReturnType<typeof existing.stat>>;
      try {
        stale = await existing.stat();
        if (!stale.isFile() || stale.uid !== process.getuid?.() || stale.mode & 0o077 || stale.size > 1024) throw unavailable();
        const buffer = Buffer.alloc(1025), read = await existing.read(buffer, 0, buffer.length, 0);
        if (read.bytesRead > 1024) throw unavailable();
        const value = Lease.parse(JSON.parse(buffer.subarray(0, read.bytesRead).toString("utf8")));
        try { process.kill(value.pid, 0); throw unavailable(); }
        catch (error: unknown) { if (!code(error, "ESRCH")) throw error; }
      } finally { await existing.close(); }
      const current = await lstat(path);
      if (current.ino !== stale.ino || current.dev !== stale.dev || current.isSymbolicLink()) throw unavailable();
      await unlink(path);
    } finally { await recovery.close(); await unlink(recoveryPath); }

  }
  throw unavailable();
}
