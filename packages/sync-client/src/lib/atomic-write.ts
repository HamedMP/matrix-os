import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";

export async function writeUtf8FileAtomic(
  filePath: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
  const tmpPath = `${filePath}.matrixos-${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, contents, {
      encoding: "utf-8",
      mode,
      flag: "wx",
    });
    await rename(tmpPath, filePath);
  } catch (err: unknown) {
    await unlink(tmpPath).catch((unlinkErr: unknown) => {
      if (
        unlinkErr instanceof Error &&
        "code" in unlinkErr &&
        (unlinkErr as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      throw unlinkErr;
    });
    throw err;
  }
}
