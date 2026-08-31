import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "../../lib/api";
import { desktopQueryClient, desktopQueryScope, type DesktopQueryScope } from "../../lib/query-client";
import { useConnection } from "../../stores/connection";
export { appIconUrl, clearPreloadedAppIcons, preloadAppIcons } from "./app-icons";

export interface MatrixApp {
  slug: string;
  name: string;
  path?: string;
  category?: string;
  appIdentity?: string;
}

const SAFE_APP_IDENTITY = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
const unavailableApi = { get: async () => [] } as unknown as ApiClient;

export const appKeys = {
  all: (scope: DesktopQueryScope) => ["apps", ...desktopQueryScope(scope)] as const,
  list: (scope: DesktopQueryScope) => ["apps", ...desktopQueryScope(scope), "list"] as const,
};

function appIdentityFromFile(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 300) return undefined;
  const identity = value
    .replace(/^\/+/, "")
    .replace(/\/index\.html$/, "")
    .replace(/\.html$/, "");
  return identity.length <= 256 && SAFE_APP_IDENTITY.test(identity) ? identity : undefined;
}

function appPathFromFile(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  const path = value.replace(/^\/+/, "");
  return path.startsWith("apps/") && !path.split("/").includes("..") ? path : undefined;
}

export function parseApps(value: unknown): MatrixApp[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { apps?: unknown }).apps)
      ? (value as { apps: unknown[] }).apps
      : [];
  const apps: MatrixApp[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const app = raw as Partial<MatrixApp> & { file?: unknown };
    if (typeof app.slug !== "string" || app.slug.trim().length === 0) continue;
    const slug = app.slug.trim();
    const name = typeof app.name === "string" && app.name.trim().length > 0 ? app.name.trim() : slug;
    const category =
      typeof app.category === "string" && app.category.trim().length > 0 ? app.category.trim() : undefined;
    const appIdentity = appIdentityFromFile(app.file);
    const path = appPathFromFile(app.file);
    apps.push({
      slug,
      name,
      ...(path ? { path } : {}),
      ...(category ? { category } : {}),
      ...(appIdentity ? { appIdentity } : {}),
    });
  }
  return apps;
}

export function appsQueryOptions(api: ApiClient, scope: DesktopQueryScope) {
  return {
    queryKey: appKeys.list(scope),
    queryFn: async ({ signal }: { signal: AbortSignal }) => parseApps(await api.get<unknown>("/api/apps", { signal })),
  };
}

export function useAppsQuery() {
  const api = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const authGeneration = useConnection((state) => state.authGeneration);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const scope = useMemo(
    () => ({ platformHost, authGeneration, runtimeSlot }),
    [authGeneration, platformHost, runtimeSlot],
  );
  return useQuery(
    {
      ...appsQueryOptions(api ?? unavailableApi, scope),
      enabled: api !== null,
    },
    desktopQueryClient,
  );
}
