import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  COLLABORATIVE_APP_ARTWORK_MAX_BYTES,
  CollaborativeAppPresentationPublishSchema,
  sniffCollaborativeAppArtworkContentType,
  type CollaborativeAppArtworkContentType,
} from "@matrix-os/contracts";
import { appIconStem, listApps, type AppEntry } from "../apps.js";

/** Matches the versioned `/icons/<stem>.png` URL the owner's own catalog resolved. */
const OWNER_ICON_URL = /^\/icons\/([A-Za-z0-9_-]{1,64})\.png(?:\?[^#]*)?$/;
const MAX_CACHED_ICONS = 500;

export interface OwnerAppArtwork {
  sha256: string;
  contentType: CollaborativeAppArtworkContentType;
  byteLength: number;
  /** Confined basename under `system/icons`; never leaves the owner home. */
  file: string;
}

export interface OwnerAppPresentation {
  name: string;
  artwork: OwnerAppArtwork | null;
}

export interface OwnerAppPresentationSource {
  resolve(appIds: readonly string[]): Promise<Map<string, OwnerAppPresentation>>;
  /** Exact bytes for a resolved artwork, or null if the file changed since it was described. */
  readArtwork(artwork: OwnerAppArtwork): Promise<Uint8Array | null>;
}

/**
 * Presentation exactly as the owner's own launcher derives it: the catalog name and the icon
 * file the catalog selected. Bundled fallbacks, symlinks, SVG, and oversize files are never
 * described, so recipients fall back to the letter tile instead of the wrong artwork.
 */
export function createOwnerAppPresentationSource(
  homePath: string,
  options: { listCatalog?: (homePath: string) => Promise<AppEntry[]> } = {},
): OwnerAppPresentationSource {
  const iconsDir = join(homePath, "system", "icons");
  const listCatalog = options.listCatalog ?? listApps;
  // Keyed by basename; re-hashed only when inode, size, or mtime change.
  const described = new Map<string, { key: string; artwork: OwnerAppArtwork | null }>();

  async function describeArtwork(app: AppEntry): Promise<OwnerAppArtwork | null> {
    const stem = appIconStem(app);
    const match = app.iconUrl ? OWNER_ICON_URL.exec(app.iconUrl) : null;
    if (!stem || match?.[1] !== stem) return null;
    const file = `${stem}.png`;
    const read = await readConfinedIcon(join(iconsDir, file), (key) => described.get(file)?.key === key);
    if (read === "unchanged") return described.get(file)!.artwork;
    if (!read) return null;
    const contentType = sniffCollaborativeAppArtworkContentType(read.bytes);
    const artwork = contentType
      ? { sha256: createHash("sha256").update(read.bytes).digest("hex"), contentType, byteLength: read.bytes.byteLength, file }
      : null;
    described.delete(file);
    if (described.size >= MAX_CACHED_ICONS) described.delete(described.keys().next().value!);
    described.set(file, { key: read.key, artwork });
    return artwork;
  }

  return {
    async resolve(appIds) {
      const wanted = new Set(appIds);
      const presentations = new Map<string, OwnerAppPresentation>();
      if (wanted.size === 0) return presentations;
      for (const app of await listCatalog(homePath)) {
        if (!app.slug || !wanted.has(app.slug) || presentations.has(app.slug)) continue;
        const name = CollaborativeAppPresentationPublishSchema.shape.name.safeParse(app.name);
        if (!name.success) continue;
        presentations.set(app.slug, { name: name.data, artwork: await describeArtwork(app) });
      }
      return presentations;
    },
    async readArtwork(artwork) {
      const read = await readConfinedIcon(join(iconsDir, artwork.file), () => false);
      if (!read || read === "unchanged") return null;
      return createHash("sha256").update(read.bytes).digest("hex") === artwork.sha256 ? read.bytes : null;
    },
  };
}

/** Opens without following symlinks and reads at most the artwork limit from a regular file. */
async function readConfinedIcon(
  path: string,
  isUnchanged: (key: string) => boolean,
): Promise<{ key: string; bytes: Uint8Array } | "unchanged" | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ELOOP" && code !== "ENOTDIR") {
      console.warn("[collaborative-app-presentation] icon unavailable", code ?? (error instanceof Error ? error.name : "UnknownError"));
    }
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > COLLABORATIVE_APP_ARTWORK_MAX_BYTES) return null;
    const key = `${info.ino}:${info.size}:${info.mtimeMs}`;
    if (isUnchanged(key)) return "unchanged";
    const bytes = new Uint8Array(info.size);
    const { bytesRead } = await handle.read(bytes, 0, info.size, 0);
    return bytesRead === info.size ? { key, bytes } : null;
  } finally {
    await handle.close();
  }
}
