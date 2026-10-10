import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export async function writeUtf8FileAtomic(
  path: string,
  data: string,
  mode = 0o600,
  hooks?: {
    beforeCommit?(tempPath: string, staged: FileHandle): Promise<void>;
    beforeCleanup?(): Promise<void>;
  },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp-${process.pid}`);
  let staged: FileHandle | undefined;
  const assertStaged = async () => {
    const entry = await lstat(tmp);
    const held = await staged!.stat();
    if (!entry.isFile() || entry.isSymbolicLink() || entry.dev !== held.dev || entry.ino !== held.ino) {
      throw new Error("Atomic-write staging entry changed");
    }
  };
  try {
    staged = await open(tmp, "wx", mode);
    await staged.writeFile(data, "utf8");
    await hooks?.beforeCommit?.(tmp, staged);
    await assertStaged();
    await rename(tmp, path);
  } catch (err) {
    if (staged) await (async () => {
      await hooks?.beforeCleanup?.();
      await assertStaged();
      await unlink(tmp);
    })().catch((cleanupErr: unknown) => {
      if (
        !(cleanupErr instanceof Error) ||
        !("code" in cleanupErr) ||
        (cleanupErr as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        console.warn(
          "[shell] failed to clean atomic-write temp file:",
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        );
      }
    });
    throw err;
  } finally { await staged?.close(); }
}
