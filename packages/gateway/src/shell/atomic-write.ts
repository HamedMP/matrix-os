import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export async function writeUtf8FileAtomic(
  path: string,
  data: string,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp-${process.pid}`);
  try {
    await writeFile(tmp, data, { flag: "wx", mode });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch((cleanupErr: unknown) => {
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
  }
}
