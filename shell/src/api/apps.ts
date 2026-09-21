import { queryOptions } from "@tanstack/react-query";
import { shellApi, type RequestOptions } from "./http";
import { canonicalOsViewCatalogPath } from "@matrix-os/contracts";
import { gatewayAssetUrl } from "@/lib/gateway";

export interface ApiAppEntry {
  name: string;
  path: string;
  slug?: string;
  icon?: string;
  iconUrl?: string;
}

interface AppIconSnapshot {
  versionedUrl: string;
}

type AppIconSnapshots = Record<string, AppIconSnapshot>;

type AppsLoader = (options?: RequestOptions) => Promise<ApiAppEntry[]>;

const MAX_ICON_URL_PRESERVATION_LOOKUPS = 1_000;
// Only gateway-owned, content-versioned icon paths may come from the catalog;
// anything else falls back to the slug-derived icon URL.
const SAFE_CATALOG_ICON_URL = /^\/icons\/[A-Za-z0-9_-]{1,64}\.(?:png|svg)(?:\?v=[A-Za-z0-9._~%-]{1,160})?$/;

export const appKeys = {
  all: () => ["apps"] as const,
  list: () => ["apps", "list"] as const,
};

export async function listApps(options?: RequestOptions): Promise<ApiAppEntry[]> {
  const value = await shellApi.get<unknown>("/api/apps", options);
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Partial<ApiAppEntry> & { file?: unknown };
    if (typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > 256) return [];
    const path = canonicalOsViewCatalogPath({ path: raw.path, file: raw.file });
    if (!path) return [];
    const { iconUrl: rawIconUrl, ...rest } = raw;
    const iconUrl = resolveCatalogIconUrl(rawIconUrl);
    return [{ ...rest, name: raw.name, path, ...(iconUrl ? { iconUrl } : {}) } as ApiAppEntry];
  });
}

/**
 * Bind a catalog-provided `/icons/<file>?v=<etag>` path to the current
 * explicit computer. The gateway returns portable root-relative paths; the
 * `?v=` version keeps the URL stable until the icon bytes change, which lets
 * the browser cache, the service worker, and the shell snapshot all reuse it.
 */
export function resolveCatalogIconUrl(
  value: unknown,
  resolveAssetUrl: (path: string) => string | undefined = gatewayAssetUrl,
): string | undefined {
  if (typeof value !== "string" || !SAFE_CATALOG_ICON_URL.test(value)) return undefined;
  return resolveAssetUrl(value);
}

export function hydrateAppIconUrls(
  apps: readonly ApiAppEntry[] | undefined,
  icons: AppIconSnapshots | undefined,
  resolveAssetUrl: (path: string) => string | undefined,
): ApiAppEntry[] | undefined {
  if (!apps) return undefined;
  return apps.map((app) => {
    if (app.iconUrl) return app;
    const iconSlug = app.icon ?? app.slug;
    const versionedUrl = iconSlug ? icons?.[iconSlug]?.versionedUrl : undefined;
    const iconUrl = versionedUrl ? resolveAssetUrl(versionedUrl) : undefined;
    return iconUrl ? { ...app, iconUrl } : app;
  });
}

function setBoundedIconLookup(
  lookup: Map<string, ApiAppEntry>,
  key: string,
  app: ApiAppEntry,
): void {
  if (lookup.has(key)) {
    lookup.delete(key);
  } else if (lookup.size >= MAX_ICON_URL_PRESERVATION_LOOKUPS) {
    const oldestKey = lookup.keys().next().value;
    if (oldestKey !== undefined) lookup.delete(oldestKey);
  }
  lookup.set(key, app);
}

function preserveAppIconUrls(
  previous: unknown,
  incoming: unknown,
): ApiAppEntry[] {
  if (!Array.isArray(incoming)) return [];
  const incomingApps = incoming as ApiAppEntry[];
  if (!Array.isArray(previous) || previous.length === 0) return incomingApps;
  const previousApps = previous as ApiAppEntry[];
  const previousByIdentity = new Map<string, ApiAppEntry>();
  for (const app of previousApps) {
    if (!app.iconUrl) continue;
    if (app.slug) setBoundedIconLookup(previousByIdentity, `slug:${app.slug}`, app);
    setBoundedIconLookup(previousByIdentity, `path:${app.path}`, app);
  }
  return incomingApps.map((app) => {
    // A future server-provided URL is authoritative. Until then, keep the
    // versioned snapshot or regenerated URL stored only in the query cache,
    // provided the catalog still identifies the same icon.
    if (app.iconUrl) return app;
    const prior = (app.slug ? previousByIdentity.get(`slug:${app.slug}`) : undefined)
      ?? previousByIdentity.get(`path:${app.path}`);
    const priorIconIdentity = prior ? (prior.icon ?? prior.slug) : undefined;
    const incomingIconIdentity = app.icon ?? app.slug;
    return prior?.iconUrl && priorIconIdentity === incomingIconIdentity
      ? { ...app, iconUrl: prior.iconUrl }
      : app;
  });
}

export function appsQueryOptions(loader: AppsLoader = listApps) {
  return queryOptions({
    queryKey: appKeys.list(),
    queryFn: ({ signal }) => loader({ signal }),
    structuralSharing: preserveAppIconUrls,
  });
}
