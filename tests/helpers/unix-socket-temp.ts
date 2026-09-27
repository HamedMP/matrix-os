import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Darwin's per-user temp path can exceed the Unix socket pathname limit once
// runtime directories are appended. Canonicalize /tmp to avoid path aliases too.
// Callers own this private, exclusively created directory and must remove it.
export async function createUnixSocketTempDir(): Promise<string> {
  const base = await realpath(process.platform === "darwin" ? "/tmp" : tmpdir());
  const directory = await mkdtemp(join(base, "mx-"));
  try {
    await chmod(directory, 0o700);
    return directory;
  } catch (error: unknown) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
