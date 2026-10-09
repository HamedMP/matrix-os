import { AppManifestSchema, type AppManifest } from "../app-runtime/manifest-schema.js";
import { APP_INDEX_SKIP_DIRS } from "../app-runtime/app-index.js";
import type { GalleryInstallResult } from "@matrix-os/contracts/app-gallery";
import { GalleryError, GalleryFileError, isFsError, type PinnedDirectory } from "./pinned-directory.js";

export async function readOwnerManifest(directory: PinnedDirectory): Promise<{ manifest: AppManifest | null; unavailable: boolean }> {
  try {
    const parsed = AppManifestSchema.safeParse(JSON.parse((await directory.readFile("matrix.json", 32_768)).toString("utf8")));
    return { manifest: parsed.success ? parsed.data : null, unavailable: false };
  } catch (error) {
    if (error instanceof GalleryFileError) return { manifest: null, unavailable: true };
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR") || error instanceof SyntaxError) return { manifest: null, unavailable: false };
    throw error;
  }
}

/** Fresh, bounded index through pinned owner directories; matches runtime discovery skips without its path cache. */
export async function indexOwnerApps(apps: PinnedDirectory) {
  // Request scoped, at most 512 directories/results. No cache can survive a File API move.
  const entries = new Map<string, GalleryInstallResult | null>();
  let directories = 0, visited = 0, unavailable = false;
  async function visit(parent: PinnedDirectory, prefix: string, depth: number): Promise<void> {
    for await (const entry of await parent.entries()) {
      if (++visited > 16_384) throw new GalleryError(503, "Owner app index entry limit");
      if (!entry.isDirectory() || APP_INDEX_SKIP_DIRS.has(entry.name)) continue;
      if (depth >= 16 || ++directories > 512) throw new GalleryError(503, "Owner app index nesting limit");
      let child: PinnedDirectory;
      try { child = await parent.child(entry.name); }
      catch (error) {
        if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR") || isFsError(error, "ELOOP")) continue;
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
