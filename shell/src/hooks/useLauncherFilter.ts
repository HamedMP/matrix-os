"use client";
import { useState } from "react";
import {
  effectiveLauncherFilter, launcherFilterChips, launcherFilterHint, matchesLauncherFilter,
  type LauncherFilter, type ShareOrganization,
} from "@matrix-os/ui/share";
import { isOsViewFixedAppPath } from "@matrix-os/contracts";
import { groupLauncherApps } from "@/lib/dock-sections";
import type { AppEntry } from "@/hooks/useWindowManager";

export const LAUNCHER_ALL_APPS_HINT = "Open an installed app, or choose Create app to start in Chat.";

/**
 * All apps · Mine · per-org filter for every Web launcher (Launchpad and the
 * legacy grid), so the two presentations cannot drift (spec 2693 phase 3).
 */
export function useLauncherFilter(apps: AppEntry[], organizations: ShareOrganization[]) {
  const mainPaths = new Set(groupLauncherApps(apps).mainApps.map((app) => app.path));
  const entry = (app: AppEntry) => ({
    organizationId: app.sharedAppTarget?.organizationId ?? null,
    // Built-ins (Notes, Whiteboard, …) are never "mine": the same rule as Electron Desktop.
    mine: !app.sharedAppTarget && !mainPaths.has(app.path) && !isOsViewFixedAppPath(app.path) && app.path !== "__create-app__",
  });
  const chips = launcherFilterChips(apps.map(entry), organizations);
  const [chosen, setChosen] = useState<LauncherFilter>("all");
  const filter = effectiveLauncherFilter(chosen, chips);
  return {
    chips,
    filter,
    setFilter: setChosen,
    matches: (app: AppEntry) => matchesLauncherFilter(entry(app), filter),
    hint: (shownCount: number) => launcherFilterHint(filter, shownCount, chips, LAUNCHER_ALL_APPS_HINT),
  };
}
