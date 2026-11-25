import { constants } from "node:fs";
import { link, open, rename } from "node:fs/promises";

/**
 * The filling and publishing steps of an app file write. They sit on one
 * object so a test can inject a failure or a racing writer at the exact step;
 * production always uses the real `fs/promises` calls.
 */
export const appFileIo = {
  /** Creates `path` exclusively, writes `content`, applies `mode` when given and syncs it to disk. */
  writeTemp: async (path: string, content: Uint8Array, mode: number | null): Promise<void> => {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
    try {
      await handle.writeFile(content);
      if (mode !== null) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from: string, to: string): Promise<void> => rename(from, to),
  link: (from: string, to: string): Promise<void> => link(from, to),
};
