import {
  COLLABORATIVE_APP_ICON_MAX_BYTES,
  COLLABORATIVE_APP_ICON_MAX_DIMENSION,
  CollaborativeAppDirectoryItemSchema,
  sniffCollaborativeAppIconContentType,
  type CollaborativeAppIconContentType,
} from "@matrix-os/contracts";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { resolveAppBySlug } from "../app-runtime/app-index.js";
import { appIconStem } from "../apps.js";

export interface CollaborativeAppPresentation {
  name?: string;
  icon?: { sha256: string; contentType: CollaborativeAppIconContentType; bytes: Uint8Array };
}

const NameSchema = CollaborativeAppDirectoryItemSchema.shape.name.unwrap();
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_DIMENSION = 8192;
const MAX_SOURCE_PIXELS = 16 * 1024 * 1024;

/** Capture owner artwork, never the launcher's generic fallback or active SVG/HTML content. */
export function createCollaborativeAppPresentationResolver(options: { homePath: string }) {
  return async (appId: string): Promise<CollaborativeAppPresentation | null> => {
    const resolved = await resolveAppBySlug(join(options.homePath, "apps"), appId);
    if (!resolved.ok) return null;
    const manifest = resolved.entry.manifest;
    const name = boundedName(manifest.name);
    const icon = await readRasterIcon(options.homePath, appIconStem({ icon: manifest.icon, slug: appId }));
    return { ...(name ? { name } : {}), ...(icon ? { icon } : {}) };
  };
}

function boundedName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()).slice(0, 120).join("").trim();
  const parsed = NameSchema.safeParse(cleaned);
  return parsed.success ? parsed.data : undefined;
}

async function readRasterIcon(homePath: string, stem: string | null): Promise<CollaborativeAppPresentation["icon"] | undefined> {
  if (!stem || !/^[A-Za-z0-9_-]+$/.test(stem)) return undefined;
  try {
    // Reject symlink parents as well as leaves. O_NOFOLLOW closes the leaf replacement race;
    // the bounded descriptor read also handles a regular file growing after stat.
    for (const directory of [join(homePath, "system"), join(homePath, "system/icons")]) {
      if (!(await lstat(directory)).isDirectory()) return undefined;
    }
    const handle = await open(join(homePath, "system/icons", `${stem}.png`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let source: Buffer;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_SOURCE_BYTES) return undefined;
      const buffer = Buffer.alloc(Math.min(stats.size + 1, MAX_SOURCE_BYTES + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_SOURCE_BYTES || length > stats.size) return undefined;
      source = buffer.subarray(0, length);
    } finally { await handle.close(); }
    if (!sniffCollaborativeAppIconContentType(source.subarray(0, 12))) return undefined;
    const image = sharp(source, { limitInputPixels: MAX_SOURCE_PIXELS, failOn: "warning", animated: false });
    try {
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || metadata.width > MAX_SOURCE_DIMENSION || metadata.height > MAX_SOURCE_DIMENSION
        || (metadata.pages ?? 1) !== 1) return undefined;
      const bytes = await image.rotate().resize(COLLABORATIVE_APP_ICON_MAX_DIMENSION, COLLABORATIVE_APP_ICON_MAX_DIMENSION, {
        fit: "inside", withoutEnlargement: true,
      }).ensureAlpha().png({ compressionLevel: 9 }).timeout({ seconds: 2 }).toBuffer();
      if (bytes.length > COLLABORATIVE_APP_ICON_MAX_BYTES) return undefined;
      return { sha256: createHash("sha256").update(bytes).digest("hex"), contentType: "image/png", bytes };
    } finally { image.destroy(); }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[collaboration] shared app icon unavailable", error instanceof Error ? error.name : "UnknownError");
    }
    return undefined;
  }
}
