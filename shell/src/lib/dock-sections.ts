import type { AppEntry } from "@/hooks/useWindowManager";

/**
 * System / built-in apps use `__name__` paths (Terminal, Files, Chat,
 * Preview, etc). User-generated apps live under `apps/<slug>/...`. The
 * dock splits these into two sections so user-generated apps sit on the
 * outer edge (recent first) while system apps cluster near the controls.
 */
export function isSystemApp(path: string): boolean {
  return path.startsWith("__");
}

/**
 * Game apps (and the Game Center) live under `apps/games/...`. The launcher
 * groups these into their own section, separate from productivity / utility
 * apps, so the grid reads as Main · Apps · Games.
 */
export function isGameApp(path: string): boolean {
  return path.startsWith("apps/games/");
}

/**
 * User apps explicitly promoted into the "Main" section alongside the system
 * apps (instead of the generated-apps section). Keyed by app slug.
 */
export const MAIN_SECTION_USER_APP_SLUGS = new Set<string>(["resource-manager"]);

/**
 * Whether an app belongs in the "Main" launcher/dock section: every system app,
 * plus a curated set of first-party user apps (e.g. Resource Manager).
 */
export function isMainSectionApp(path: string): boolean {
  if (isSystemApp(path)) return true;
  const slug = path.replace(/^apps\//, "").split("/")[0];
  return MAIN_SECTION_USER_APP_SLUGS.has(slug);
}

export interface LauncherAppGroups {
  mainApps: AppEntry[];
  generatedApps: AppEntry[];
  gameApps: AppEntry[];
}

/**
 * Group + order the full app list into the launcher's Main / My Apps / Games
 * sections. Shared by the classic MissionControl grid (sections with
 * dividers) and the macOS Launchpad (one flattened grid) so both launchers
 * always show apps in the same order.
 */
export function groupLauncherApps(
  apps: AppEntry[],
  dockOrder: { systemApps?: string[]; userApps?: string[] } | undefined,
  launchTimes: Record<string, number>,
): LauncherAppGroups {
  const main: AppEntry[] = [];
  const gen: AppEntry[] = [];
  const games: AppEntry[] = [];
  for (const app of apps) {
    if (isMainSectionApp(app.path)) main.push(app);
    else if (isGameApp(app.path)) games.push(app);
    else gen.push(app);
  }
  return {
    mainApps: applyOrder(main, dockOrder?.systemApps, launchTimes),
    generatedApps: applyOrder(gen, dockOrder?.userApps, launchTimes),
    gameApps: applyOrder(games, dockOrder?.userApps, launchTimes),
  };
}

/**
 * Apply a persisted user order to a list of apps. Apps not in the
 * persisted order get prepended (in launch-time-desc order) so freshly-
 * built apps land at the outer edge before the user has dragged them.
 *
 * @param apps        full list to order
 * @param persisted   user-set path order (most-recent edge first), or undefined
 * @param launchTimes per-app last-launched timestamp; missing entries treated as 0
 */
export function applyOrder(
  apps: AppEntry[],
  persisted: string[] | undefined,
  launchTimes: Record<string, number>,
): AppEntry[] {
  if (!persisted || persisted.length === 0) {
    // No user order yet. Sort: never-opened apps first (in original order
    // -- they're brand new, so "most recent" by the user's mental model),
    // then opened apps by launch-time descending.
    return apps.toSorted((a, b) => {
      const ta = launchTimes[a.path];
      const tb = launchTimes[b.path];
      if (ta === undefined && tb === undefined) return 0;
      if (ta === undefined) return -1;
      if (tb === undefined) return 1;
      return tb - ta;
    });
  }

  const persistedSet = new Set(persisted);
  const appsByPath = new Map(apps.map((a) => [a.path, a]));
  const known: AppEntry[] = [];
  for (const path of persisted) {
    const app = appsByPath.get(path);
    if (app) known.push(app);
  }
  // New apps the user hasn't seen yet: prepend in recency order so they
  // appear at the outer edge of the section.
  const newcomers = apps
    .filter((a) => !persistedSet.has(a.path))
    .sort((a, b) => {
      const ta = launchTimes[a.path];
      const tb = launchTimes[b.path];
      if (ta === undefined && tb === undefined) return 0;
      if (ta === undefined) return -1;
      if (tb === undefined) return 1;
      return tb - ta;
    });
  return [...newcomers, ...known];
}
