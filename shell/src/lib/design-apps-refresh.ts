import type { AppEntry } from "@/hooks/useWindowManager";

export interface ApiAppEntry {
  name: string;
  path: string;
  slug?: string;
  icon?: string;
}

/**
 * Reconcile the launcher app list after an OS design switch. The gateway
 * re-filters design-scoped apps on every /api/apps call, but the shell only
 * bootstraps its list once — so on a mid-session design change we refetch
 * and merge: newly-matching scoped apps appear, apps that left scope
 * disappear, and everything else (built-ins, module-registered apps, user
 * apps without a designs field) stays untouched.
 *
 * Removals are bounded to `previousApiPaths` (the paths the last /api/apps
 * fetch actually returned) so module-registered entries that merely share an
 * `apps/` prefix are never removed by an API refresh.
 */
export function reconcileDesignApps(input: {
  current: readonly AppEntry[];
  apiApps: readonly ApiAppEntry[];
  previousApiPaths: ReadonlySet<string>;
  normalizePath: (path: string) => string;
  iconUrlFor: (app: ApiAppEntry) => string | undefined;
}): { next: AppEntry[]; apiPaths: Set<string> } {
  const { current, apiApps, previousApiPaths, normalizePath, iconUrlFor } = input;
  const apiPaths = new Set(apiApps.map((app) => normalizePath(app.path)));
  const next = current.filter(
    (entry) => !previousApiPaths.has(entry.path) || apiPaths.has(entry.path),
  );
  const existing = new Set(next.map((entry) => entry.path));
  for (const app of apiApps) {
    const path = normalizePath(app.path);
    if (existing.has(path)) continue;
    next.push({ name: app.name, path, iconUrl: iconUrlFor(app) });
  }
  return { next, apiPaths };
}
