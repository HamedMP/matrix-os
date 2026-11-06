import { opendir, rmdir } from "node:fs/promises";
import { join } from "node:path";

/** Call only after the runtime unit/cgroup is quiesced and parent ownership is verified. */
export async function removeQuiescedCommandStaging(commandDirectory: string): Promise<void> {
  let directory;
  try { directory = await opendir(commandDirectory); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let count = 0;
  for await (const entry of directory) {
    if (++count > 128) throw new Error("Scope runtime command cleanup exceeds capacity");
    if (entry.name.startsWith(".w-") || entry.isDirectory()) {
      if (!/^\.w-[A-Za-z0-9]{6}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("Unsafe scope runtime command staging");
      }
      // UID0/CapEff0 cannot traverse worker-owned02700. Parent wx permits rmdir
      // of the empty directory. Nonempty/inaccessible/unexpected objects fail closed.
      await rmdir(join(commandDirectory, entry.name));
    }
  }
}
