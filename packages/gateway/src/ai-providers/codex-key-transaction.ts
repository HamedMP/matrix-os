import { constants, type Stats } from "node:fs";
import { chmod, lstat, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeProviderWriteNotStartedError, NativeProviderWriteRestoredError } from "./native-provider-profile-guard.js";
import { ProviderWorkflowError } from "./provider-workflows.js";

const MAX_AUTH_BYTES = 65_536;
/** Preserve the bounded recovery backup and durable lease for operator recovery. */
export class CodexKeyRollbackFailedError extends ProviderWorkflowError { constructor() { super("unavailable"); } }
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeMs === b.mtimeMs;
const missing = (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

async function currentFile(path: string): Promise<Stats | null> {
  try { return await lstat(path); }
  catch (error) { if (missing(error)) return null; throw error; }
}

/** Called under the exclusive native profile lease, after the staged CLI drained.
 * Restore only our installed inode: cooperating writers cannot race the lease.
 * Same-UID/root actors replacing pathname targets are within the runtime trust boundary.
 */
export async function commitCodexKey(input: {
  directory: string;
  directoryIdentity: Stats;
  staging: string;
  commit: () => Promise<void>;
}): Promise<void> {
  const target = join(input.directory, "auth.json"), staged = join(input.staging, "auth.json");
  const backup = join(input.staging, "previous-auth");
  let original: Stats | null;
  let installed: Stats;
  const checkDirectory = async () => {
    const current = await lstat(input.directory);
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== input.directoryIdentity.dev || current.ino !== input.directoryIdentity.ino) throw new ProviderWorkflowError("unavailable");
  };
  try {
    original = await currentFile(target);
    if (original) {
      if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1 || original.size > MAX_AUTH_BYTES
        || original.uid !== process.getuid?.() || (original.mode & 0o077) !== 0) throw new ProviderWorkflowError("unavailable");
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const bytes = Buffer.alloc(original.size + 1);
      try {
        const before = await handle.stat();
        if (!sameFile(original, before)) throw new ProviderWorkflowError("unavailable");
        const read = await handle.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== before.size || !sameFile(before, await handle.stat())) throw new ProviderWorkflowError("unavailable");
        await writeFile(backup, bytes.subarray(0, read.bytesRead), { flag: "wx", mode: original.mode & 0o777 });
        await chmod(backup, original.mode & 0o777);
      } finally { bytes.fill(0); await handle.close(); }
    }
    await checkDirectory();
    const beforePublish = await currentFile(target);
    if (original ? !beforePublish || !sameFile(original, beforePublish) : beforePublish !== null) throw new ProviderWorkflowError("unavailable");
    installed = await lstat(staged);
    if (!installed.isFile() || installed.isSymbolicLink() || installed.nlink !== 1 || installed.size > MAX_AUTH_BYTES
      || installed.uid !== process.getuid?.() || (installed.mode & 0o777) !== 0o600) throw new ProviderWorkflowError("unavailable");
    await rename(staged, target);
  } catch (error) {
    console.warn("[provider-workflow] Codex key publication not started:", error instanceof Error ? error.name : "UnknownError");
    throw new NativeProviderWriteNotStartedError();
  }
  try { await input.commit(); }
  catch (error) {
    try {
      await checkDirectory();
      const current = await currentFile(target);
      if (!current || !current.isFile() || current.isSymbolicLink() || !sameFile(installed, current)) throw new ProviderWorkflowError("unavailable");
      if (original) await rename(backup, target);
      else await unlink(target);
    } catch (rollbackError) {
      console.warn("[provider-workflow] Codex key rollback unavailable:", rollbackError instanceof Error ? rollbackError.name : "UnknownError");
      throw new CodexKeyRollbackFailedError();
    }
    console.warn("[provider-workflow] Codex Connect rejected after key staging:", error instanceof Error ? error.name : "UnknownError");
    throw new NativeProviderWriteRestoredError();
  }
}
