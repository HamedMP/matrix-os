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

function preserveAppIconUrls(
  previous: unknown,
  incoming: unknown,
): ApiAppEntry[] {
  if (!Array.isArray(incoming)) return [];
  const incomingApps = incoming as ApiAppEntry[];
  if (!Array.isArray(previous) || previous.length === 0) return incomingApps;
  const previousApps = previous as ApiAppEntry[];
  const previousBySlug = new Map(
    previousApps.flatMap((app) => app.slug ? [[app.slug, app] as const] : []),
  );
  const previousByPath = new Map(previousApps.map((app) => [app.path, app] as const));
  return incomingApps.map((app) => {
    // A future server-provided URL is authoritative. Until then, keep the
    // versioned snapshot or regenerated URL stored only in the query cache.
    if (app.iconUrl) return app;
    const prior = (app.slug ? previousBySlug.get(app.slug) : undefined) ?? previousByPath.get(app.path);
    return prior?.iconUrl ? { ...app, iconUrl: prior.iconUrl } : app;
  });
}

export function appsQueryOptions(loader: AppsLoader = listApps) {
  return queryOptions({
    queryKey: appKeys.list(),
    queryFn: ({ signal }) => loader({ signal }),
    structuralSharing: preserveAppIconUrls,
  });
}
