import { link, rename } from "node:fs/promises";

/**
 * The two publishing steps of an app file write. They sit on one object so a
 * test can inject a failure or a racing writer at the exact publish point;
 * production always uses the real `fs/promises` calls.
 */
export const appFileIo = {
  rename: (from: string, to: string): Promise<void> => rename(from, to),
  link: (from: string, to: string): Promise<void> => link(from, to),
};
