/** Restore a built Electron renderer even if a capture-time write truncates it. */
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RendererAssetPatch {
  file: string;
  backup: string;
  backupDirectory: string;
}

export function patchRendererAsset(
  file: string,
  replacement: string,
  write: (path: string, contents: string) => void = writeFileSync,
): RendererAssetPatch {
  const backupDirectory = mkdtempSync(join(tmpdir(), "s20-renderer-"));
  const backup = join(backupDirectory, "original.js");
  try {
    copyFileSync(file, backup);
    write(file, replacement);
  } catch (error: unknown) {
    if (existsSync(backup)) {
      // Keep the backup if restoration fails, so the built artifact is recoverable.
      copyFileSync(backup, file);
    }
    rmSync(backupDirectory, { recursive: true, force: true });
    throw error;
  }
  return { file, backup, backupDirectory };
}

export function restoreRendererAsset(patch: RendererAssetPatch): void {
  copyFileSync(patch.backup, patch.file);
  rmSync(patch.backupDirectory, { recursive: true, force: true });
}
