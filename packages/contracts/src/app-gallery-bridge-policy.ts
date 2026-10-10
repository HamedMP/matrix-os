import { canonicalOsViewCatalogPath } from "./os-view.js";

/** Shared exact-path capability policy for the Web and Electron app bridges. */
export function isAllowedAppGalleryBridgeRequest(url: string, method = "GET"): boolean {
  if (url === "/api/app-gallery" || url === "/api/integrations") return method === "GET";
  return method === "POST" && /^\/api\/app-gallery\/[a-z][a-z0-9-]{0,47}\/install$/.test(url);
}

// Capability identities are intentionally narrower than general installed apps.
// These are the first-party catalog namespaces; owner copies under other paths
// do not inherit gateway credentials or inventory access.
export const APP_GALLERY_STARTER_IDENTITIES = [
  "folio", "atlas", "agenda", "follow-ups", "subscriptions", "deliveries",
  "reading-library", "people", "files", "notes", "habits", "focus",
  "cashflow", "revenue", "pipeline", "projects", "meeting-briefs", "support",
  "hiring", "company-spend", "releases", "knowledge", "campaigns", "analytics",
  "workout-coach", "paycheck-runway", "meal-planner", "job-search",
  "study-notes", "journal-memory", "chess-coach",
] as const;
export function isAppGalleryIdentity(identity: string, routeSlug = identity): boolean {
  return identity === "app-gallery" && routeSlug === "app-gallery";
}
export function isAppGalleryInventoryIdentity(identity: string, routeSlug = identity): boolean {
  return identity === routeSlug && (isAppGalleryIdentity(identity, routeSlug)
    || APP_GALLERY_STARTER_IDENTITIES.some((id) => id === identity));
}

/** Runtime catalog roots may be longer than persisted OS-view references. */
export function canonicalAppRuntimeCatalogPath(row: { path?: unknown; file?: unknown }): string | null {
  for (const [value, fromFile] of [[row.path, false], [row.file, true]] as const) {
    if (typeof value !== "string" || value.length > 4128 || /[\u0000-\u001f\u007f%?#:\\]/.test(value)) continue;
    let path = value.trim().replace(/^\/+/, "").replace(/^files\//, "");
    if (fromFile && !path.startsWith("apps/")) path = `apps/${path}`;
    if (!path.startsWith("apps/")) continue;
    const parts = path.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || new TextEncoder().encode(part).length > 255)) continue;
    const root = path.replace(/\/(?:dist\/)?index\.html$/, "");
    if (root.length > 4096 || root.split("/").length > 17) continue;
    const persisted = canonicalOsViewCatalogPath({ path });
    if (persisted) return persisted;
    if (path.endsWith("/index.html") && root !== path) return path;
  }
  return null;
}
