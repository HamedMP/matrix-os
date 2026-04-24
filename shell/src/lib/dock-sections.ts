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
    return [...apps].sort((a, b) => {
      const ta = launchTimes[a.path];
      const tb = launchTimes[b.path];
      if (ta === undefined && tb === undefined) return 0;
      if (ta === undefined) return -1;
      if (tb === undefined) return 1;
      return tb - ta;
    });
  }

  const persistedSet = new Set(persisted);
  const known: AppEntry[] = [];
  for (const path of persisted) {
    const app = apps.find((a) => a.path === path);
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
