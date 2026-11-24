import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  COLLABORATIVE_APP_ICON_MAX_BYTES,
  COLLABORATIVE_APP_ICON_MAX_DIMENSION,
  CollaborativeAppThumbnailSchema,
  sniffCollaborativeAppIconContentType,
} from "@matrix-os/contracts";

export interface DirectoryThumbnail { bytes: Uint8Array; contentType: "image/png"; sha256: string }

/** An invalid optional thumbnail never rejects the routing metadata beside it. */
export async function readDirectoryThumbnail(value: unknown): Promise<DirectoryThumbnail | null> {
  const parsed = CollaborativeAppThumbnailSchema.safeParse(value);
  if (!parsed.success) return null;
  const { base64, sha256 } = parsed.data;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64 || bytes.length > COLLABORATIVE_APP_ICON_MAX_BYTES
    || sniffCollaborativeAppIconContentType(bytes) !== "image/png"
    || createHash("sha256").update(bytes).digest("hex") !== sha256) return null;
  const image = sharp(bytes, { limitInputPixels: COLLABORATIVE_APP_ICON_MAX_DIMENSION ** 2, failOn: "warning" });
  try {
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width > COLLABORATIVE_APP_ICON_MAX_DIMENSION
      || metadata.height > COLLABORATIVE_APP_ICON_MAX_DIMENSION || (metadata.pages ?? 1) !== 1) return null;
    // Actually decode: a valid signature/IHDR alone does not make a valid raster image.
    await image.raw().timeout({ seconds: 1 }).toBuffer();
    return { bytes, contentType: "image/png", sha256 };
  } catch (error: unknown) {
    console.warn("[platform-collaboration] invalid thumbnail", error instanceof Error ? error.name : "UnknownError");
    return null;
  } finally { image.destroy(); }
}

/** One-time upgrade of referenced preview uploads, including artwork above the new byte budget. */
export async function resizeLegacyAppIcon(source: Uint8Array): Promise<DirectoryThumbnail | null> {
  // Original PR enforced 256 KiB. Never buffer/decode arbitrary historical content.
  if (source.length > 256 * 1024 || !sniffCollaborativeAppIconContentType(source.subarray(0, 12))) return null;
  const image = sharp(source, { limitInputPixels: 16 * 1024 * 1024, failOn: "warning" });
  try {
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192
      || (metadata.pages ?? 1) !== 1) return null;
    const bytes = await image.rotate().resize(COLLABORATIVE_APP_ICON_MAX_DIMENSION, COLLABORATIVE_APP_ICON_MAX_DIMENSION, {
      fit: "inside", withoutEnlargement: true,
    }).ensureAlpha().png({ compressionLevel: 9 }).timeout({ seconds: 2 }).toBuffer();
    if (bytes.length > COLLABORATIVE_APP_ICON_MAX_BYTES) return null;
    return { bytes, contentType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error: unknown) {
    console.warn("[platform-collaboration] legacy artwork unavailable", error instanceof Error ? error.name : "UnknownError");
    return null;
  } finally { image.destroy(); }
}
