import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { resolveSystemIconPath } from "./default-icons.js";

const SAFE_ICON_STEM = /^[a-zA-Z0-9_-]{1,64}$/;

export const VERSIONED_ICON_MAX_AGE_SECONDS = 31_536_000;
export const UNVERSIONED_ICON_MAX_AGE_SECONDS = 86_400;

export interface SystemIconMetadata {
  url: string;
  etag: string;
  version: string;
  versionedUrl: string;
}

export function iconEtag(input: { mtimeMs: number; size: number }): string {
  return `"${input.mtimeMs.toString(36)}-${input.size.toString(36)}"`;
}

export function iconVersion(etag: string): string {
  return etag.replace(/^W\//, "").replace(/^"|"$/g, "");
}

export function versionedIconUrl(url: string, etag: string): string {
  const version = iconVersion(etag);
  if (!version) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`;
}

export async function resolveSystemIconMetadata(
  homePath: string,
  iconStem: string,
): Promise<SystemIconMetadata | null> {
  if (!SAFE_ICON_STEM.test(iconStem)) return null;
  const target = await resolveSystemIconPath(homePath, `${iconStem}.png`);
  if (!target) return null;
  try {
    const iconStat = await stat(target);
    const etag = iconEtag(iconStat);
    const url = `/icons/${basename(target)}`;
    return {
      url,
      etag,
      version: iconVersion(etag),
      versionedUrl: versionedIconUrl(url, etag),
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[icons] failed to stat icon metadata:", err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}
