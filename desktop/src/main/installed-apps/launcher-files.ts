// File helpers shared by the Windows and Linux launchers (spec 2711, layer 4):
// a launcher is written under a temp name and then hard-linked to its final
// name, which fails instead of overwriting; removal touches only a regular
// file that is a direct child of the launcher folder, never a symlink.
import { lstat, link, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export class LauncherPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherPathError";
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** Moves a finished temp file to `finalPath`; false when that name is taken. The temp file is always removed. */
export async function publishExclusive(tempPath: string, finalPath: string): Promise<boolean> {
  try {
    await link(tempPath, finalPath);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(tempPath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") console.warn("[installed-apps] temp launcher cleanup failed:", error instanceof Error ? error.name : "UnknownError");
    });
  }
}

/** Deletes `path` only when it is a regular file directly in `dir` whose name `ownName` accepts. Gone is fine. */
export async function removeOwnedFile(dir: string, path: string, ownName: (name: string) => boolean): Promise<void> {
  const target = resolve(path);
  if (dirname(target) !== resolve(dir) || !ownName(basename(target))) {
    throw new LauncherPathError("Launcher is outside its folder");
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new LauncherPathError("Launcher is not a file");
    await unlink(target);
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}
