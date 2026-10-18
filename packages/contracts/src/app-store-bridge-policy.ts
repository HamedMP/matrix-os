/** Exact bridge capabilities for App Store surfaces and community apps (spec 631, contracts/bridge-policy.md). */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SLUG = "[a-z][a-z0-9-]{2,47}";

interface Route { method: "GET" | "POST"; path: RegExp; query?: { allowed: readonly string[]; required?: readonly string[] } }

const route = (method: Route["method"], path: string, query?: Route["query"]): Route =>
  ({ method, path: new RegExp(`^${path}$`), ...(query ? { query } : {}) });

const GALLERY_ROUTES: readonly Route[] = [
  route("GET", "/api/app-store/status"),
  route("GET", "/api/app-store/publishable-apps"),
  route("GET", `/api/app-store/installs/${UUID}`),
  route("GET", "/api/app-store/drafts"),
  route("POST", "/api/app-store/drafts"),
  route("GET", `/api/app-store/drafts/${UUID}`),
  route("GET", `/api/app-store/drafts/${UUID}/diff`, { allowed: ["path"], required: ["path"] }),
  route("POST", `/api/app-store/drafts/${UUID}/(?:revise|submit|listing|delete)`),
  route("GET", "/api/app-store/submissions", { allowed: ["cursor"] }),
  route("POST", `/api/app-store/submissions/${UUID}/withdraw`),
  route("GET", "/api/app-store/listings", { allowed: ["q", "category", "sort", "cursor", "limit"] }),
  route("GET", `/api/app-store/listings/${SLUG}`),
  route("GET", `/api/app-store/listings/${SLUG}/icon`),
  route("POST", `/api/app-store/listings/${SLUG}/(?:install|rating)`),
];

/** Reviewer surface inside Gallery; the platform enforces the reviewer allowlist on every call. */
const REVIEW_ROUTES: readonly Route[] = [
  route("GET", "/api/app-store/review/queue", { allowed: ["status", "cursor"] }),
  route("GET", `/api/app-store/review/versions/${UUID}`),
  route("GET", `/api/app-store/review/versions/${UUID}/file`, { allowed: ["path", "previous"], required: ["path"] }),
  route("POST", `/api/app-store/review/versions/${UUID}/decision`),
  route("POST", `/api/app-store/review/listings/${UUID}/action`),
];

const COMMUNITY_ROUTES: readonly Route[] = [
  route("POST", "/api/bridge/query"),
  route("POST", "/api/bridge/data"),
  route("POST", "/api/bridge/capabilities"),
  route("GET", "/api/bridge/service"),
  route("POST", "/api/bridge/service"),
  route("POST", "/api/bridge/ai"),
  route("GET", "/api/bridge/ai/routes"),
];

function matches(routes: readonly Route[], url: string, method: string): boolean {
  if (typeof url !== "string" || url.length > 2048 || url.includes("#") || !url.startsWith("/")) return false;
  let parsed: URL;
  try {
    parsed = new URL(url, "https://bridge.invalid");
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  const rawPath = url.split("?", 1)[0];
  if (parsed.origin !== "https://bridge.invalid" || parsed.pathname !== rawPath || rawPath.includes("%")) return false;
  const hasQuery = url.includes("?");
  for (const candidate of routes) {
    if (candidate.method !== method || !candidate.path.test(rawPath)) continue;
    if (!candidate.query) return !hasQuery;
    const keys = [...parsed.searchParams.keys()];
    if (new Set(keys).size !== keys.length) return false;
    if (keys.some(key => !candidate.query!.allowed.includes(key))) return false;
    return (candidate.query.required ?? []).every(key => parsed.searchParams.get(key));
  }
  return false;
}

export function isAllowedStoreReviewRequest(url: string, method = "GET"): boolean {
  return matches(REVIEW_ROUTES, url, method);
}

/** Every App Store route the Gallery identity may call, including the reviewer tab. */
export function isAllowedAppStoreGalleryRequest(url: string, method = "GET"): boolean {
  return matches(GALLERY_ROUTES, url, method) || matches(REVIEW_ROUTES, url, method);
}

/** Community apps reach only host-stamped data, capability and owner-governed AI bridges. */
export function isCommunityBridgeRequestAllowed(url: string, method = "GET"): boolean {
  return matches(COMMUNITY_ROUTES, url, method);
}

/** Store calls that move bundles take longer than ordinary bridge reads. */
export function appStoreBridgeTimeoutMs(url: string): number {
  if (/^\/api\/app-store\/listings\/[a-z][a-z0-9-]{2,47}\/install$/.test(url)) return 120_000;
  if (/^\/api\/app-store\/drafts\/[0-9a-f-]{36}\/submit$/.test(url)) return 120_000;
  return 15_000;
}
