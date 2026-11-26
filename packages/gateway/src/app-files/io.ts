import { constants } from "node:fs";
import { link, open, rename } from "node:fs/promises";

/**
 * The filling and publishing steps of an app file write. They sit on one
 * object so a test can inject a failure or a racing writer at the exact step;
 * production always uses the real `fs/promises` calls.
 */
export const appFileIo = {
  /**
   * Creates `path` exclusively, writes `content`, applies `mode` when given and
   * syncs it to disk. A replacement (`mode` given) starts owner-only, or at the
   * original's bits where those are stricter, and gets its final permissions
   * only once the bytes are written, so a reader the original shuts out cannot
   * open the temp copy in between. A new file is published as this inode, so
   * its umask-limited mode is the final one.
   */
  writeTemp: async (path: string, content: Uint8Array, mode: number | null): Promise<void> => {
    const createMode = mode === null ? 0o666 : mode & 0o600;
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, createMode);
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
