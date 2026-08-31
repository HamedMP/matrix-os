import { queryOptions } from "@tanstack/react-query";
import { shellApi, type RequestOptions } from "./http";

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

export const appKeys = {
  all: () => ["apps"] as const,
  list: () => ["apps", "list"] as const,
};

export async function listApps(options?: RequestOptions): Promise<ApiAppEntry[]> {
  const value = await shellApi.get<unknown>("/api/apps", options);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ApiAppEntry => (
    Boolean(entry)
    && typeof entry === "object"
    && typeof (entry as ApiAppEntry).name === "string"
    && typeof (entry as ApiAppEntry).path === "string"
  ));
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
