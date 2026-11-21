import {
  COLLABORATIVE_APP_ICON_MAX_BYTES,
  CollaborativeAppDirectoryItemSchema,
  sniffCollaborativeAppIconContentType,
  type CollaborativeAppIconContentType,
} from "@matrix-os/contracts";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAppBySlug } from "../app-runtime/app-index.js";
import { appIconStem } from "../apps.js";
import { resolveBundledSystemIconPath } from "../default-icons.js";

export interface CollaborativeAppPresentation {
  name?: string;
  icon?: { sha256: string; contentType: CollaborativeAppIconContentType; bytes: Uint8Array };
}

const NameSchema = CollaborativeAppDirectoryItemSchema.shape.name.unwrap();
const MAX_NAME_CHARS = 120;

/**
 * ENG-490: the owner's manifest display name and the app's own raster icon file
 * (`system/icons/<stem>.png`). The launcher's generic fallback artwork is never sent, so an app
 * without its own icon keeps the member's letter tile. SVG and oversized or unrecognized bytes are
 * omitted so only inert raster artwork ever leaves the home for the platform origin.
 */
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
  // Control characters never reach a member launcher; overlong names are cut at a code point.
  const cleaned = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()).slice(0, MAX_NAME_CHARS).join("").trim();
  const parsed = NameSchema.safeParse(cleaned);
  return parsed.success ? parsed.data : undefined;
}

async function readRasterIcon(homePath: string, stem: string | null): Promise<CollaborativeAppPresentation["icon"] | undefined> {
  if (!stem) return undefined;
  const target = await resolveBundledSystemIconPath(homePath, `${stem}.png`);
  if (!target || !target.endsWith(".png")) return undefined;
  try {
    const stats = await lstat(target);
    if (!stats.isFile() || stats.size > COLLABORATIVE_APP_ICON_MAX_BYTES) return undefined;
    const bytes = new Uint8Array(await readFile(target));
    const contentType = sniffCollaborativeAppIconContentType(bytes);
    if (!contentType) return undefined;
    return { sha256: createHash("sha256").update(bytes).digest("hex"), contentType, bytes };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[collaboration] shared app icon unavailable", error instanceof Error ? error.name : "UnknownError");
    }
    return undefined;
  }
}
