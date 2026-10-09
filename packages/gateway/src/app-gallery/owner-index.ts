import { AppManifestSchema, type AppManifest } from "../app-runtime/manifest-schema.js";
import { APP_INDEX_SKIP_DIRS } from "../app-runtime/app-index.js";
import type { GalleryInstallResult } from "@matrix-os/contracts/app-gallery";
import { GalleryError, GalleryFileError, isFsError, type PinnedDirectory } from "./pinned-directory.js";

/** Owner permission/symlink restrictions leave identity unverifiable; unexpected I/O still fails. */
export function isOwnerFileUnavailable(error: unknown): boolean {
  return error instanceof GalleryFileError || ["EACCES", "EPERM", "ELOOP"].some(code => isFsError(error, code));
}

export async function readOwnerManifest(directory: PinnedDirectory): Promise<{ manifest: AppManifest | null; unavailable: boolean }> {
  try {
    const parsed = AppManifestSchema.safeParse(JSON.parse((await directory.readFile("matrix.json", 32_768)).toString("utf8")));
    return { manifest: parsed.success ? parsed.data : null, unavailable: false };
  } catch (error) {
    if (isOwnerFileUnavailable(error)) return { manifest: null, unavailable: true };
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR") || error instanceof SyntaxError) return { manifest: null, unavailable: false };
    throw error;
  }
}

/** Fresh, bounded index through pinned owner directories; matches runtime discovery skips without its path cache. */
export async function indexOwnerApps(apps: PinnedDirectory) {
  // Request scoped, at most 512 directories/results. No cache can survive a File API move.
  const entries = new Map<string, GalleryInstallResult | null>();
  let directories = 0, visited = 0, unavailable = false;
  async function* readableEntries(parent: PinnedDirectory) {
    try { for await (const entry of await parent.entries()) yield entry; }
    catch (error) {
      if (isOwnerFileUnavailable(error)) { unavailable = true; return; }
      if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) return;
      throw error;
    }
  }
  async function visit(parent: PinnedDirectory, prefix: string, depth: number): Promise<void> {
    for await (const entry of readableEntries(parent)) {
      if (++visited > 16_384) throw new GalleryError(503, "Owner app index entry limit");
      if (!entry.isDirectory() || APP_INDEX_SKIP_DIRS.has(entry.name)) continue;
      if (depth >= 16 || ++directories > 512) throw new GalleryError(503, "Owner app index nesting limit");
      let child: PinnedDirectory;
      try { child = await parent.child(entry.name); }
      catch (error) {
        if (isOwnerFileUnavailable(error)) { unavailable = true; continue; }
        if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) continue;
        throw error;
      }
      try {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const read = await readOwnerManifest(child); unavailable ||= read.unavailable;
        if (read.manifest && read.manifest.slug !== "symphony") {
          const { slug, name } = read.manifest;
          entries.set(slug, entries.has(slug) ? null : { status: "already_installed", slug, name, path: `apps/${path}` });
        }
        await visit(child, path, depth + 1);
      } finally { await child.close(); }
    }
  }
  await visit(apps, "", 0);
  return { entries, unavailable };
}
