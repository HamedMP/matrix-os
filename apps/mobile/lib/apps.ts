import type { MatrixAppEntry, MatrixAppManifestResponse } from "@/lib/gateway-client";
import { encodeAppSlugPath } from "@/lib/app-slugs";

export type { MatrixAppEntry, MatrixAppManifestResponse };
export { encodeAppSlugPath };

const SAFE_APP_SLUG_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;

export function getAppSlug(app: Pick<MatrixAppEntry, "file" | "path" | "name" | "slug">): string {
  const source = app.slug || app.file || app.path;
  const normalized = source ? normalizeAppSlug(source) : null;
  return normalized ?? slugifyName(app.name);
}

/** Catalog slugs may alias a migrated runtime; storage and grants use its file identity. */
export function getAppIdentity(app: Pick<MatrixAppEntry, "file" | "path" | "name" | "slug">): string {
  return (app.file ? normalizeAppSlug(app.file) : null)
    ?? (app.path ? normalizeAppSlug(app.path) : null)
    ?? getAppSlug(app);
}

function normalizeAppSlug(source: string): string | null {
  const withoutCacheParams = source.split(/[?#]/, 1)[0] ?? "";
  const normalizedPath = withoutCacheParams
    .replace(/\\/g, "/")
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^(files\/)?apps\//i, "")
    .replace(/\/(?:dist\/)?index\.html$/i, "")
    .replace(/\.html$/i, "")
    .toLowerCase();

  const parts = normalizedPath.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((part) => !SAFE_APP_SLUG_SEGMENT.test(part))) return null;
  return parts.join("/");
}

function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "app";
}
