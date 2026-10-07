/** Shared exact-path capability policy for the Web and Electron app bridges. */
export function isAllowedAppGalleryBridgeRequest(url: string, method = "GET"): boolean {
  if (url === "/api/app-gallery" || url === "/api/bridge/service") return method === "GET";
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
