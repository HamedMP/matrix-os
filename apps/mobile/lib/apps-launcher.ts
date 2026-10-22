import { OS_VIEW_FIXED_APP_APPEARANCES, OS_VIEW_PLACEABLE_BUILTIN_APPS } from "@matrix-os/contracts";

import { getAppInstallPath, type MatrixAppEntry } from "@/lib/apps";

// What the Apps tab lists and in which order. It follows the desktop launcher:
// the default apps first, in the launcher's own order, then every other
// installed app.

type CatalogApp = Pick<MatrixAppEntry, "file" | "path" | "name">;

/** Where a default app that is a screen of this app opens. */
export type DefaultAppDestination =
  | { kind: "tab"; tab: "chats" | "terminal" | "settings" }
  | { kind: "screen"; href: "/files" | "/integrations" };

// The desktop defaults that are screens of this app, keyed by the launcher's
// id for them. Editor, VS Code, Browser and Cloud desktop have no screen here
// and are left out.
const DEFAULT_APP_DESTINATIONS = {
  chat: { kind: "tab", tab: "chats" },
  terminal: { kind: "tab", tab: "terminal" },
  files: { kind: "screen", href: "/files" },
  settings: { kind: "tab", tab: "settings" },
  plugins: { kind: "screen", href: "/integrations" },
} as const satisfies Record<string, DefaultAppDestination>;

export type DefaultAppId = keyof typeof DEFAULT_APP_DESTINATIONS;

// Desktop defaults that are installed web apps. They open like any other
// installed app and are listed only on a computer that has them.
const PROMOTED_INSTALL_PATHS: readonly string[] = ["notes", "whiteboard"];

// Installed web apps the desktop launcher folds into a default app instead of
// listing: older computers still carry them.
const REPLACED_INSTALL_PATHS: readonly string[] = ["chat", "terminal", "workspace", "browser"];

export type LauncherEntry<App extends CatalogApp = CatalogApp> =
  | { kind: "default"; id: DefaultAppId; name: string; destination: DefaultAppDestination }
  | { kind: "installed"; name: string; app: App };

function isDefaultAppId(id: string): id is DefaultAppId {
  return Object.prototype.hasOwnProperty.call(DEFAULT_APP_DESTINATIONS, id);
}

function installedEntry<App extends CatalogApp>(app: App): LauncherEntry<App> {
  return { kind: "installed", name: app.name, app };
}

/** The Apps grid for a computer's installed apps, which stay in the order given. */
export function buildLauncherEntries<App extends CatalogApp>(apps: readonly App[]): LauncherEntry<App>[] {
  const located = apps.map((app) => ({ app, installPath: getAppInstallPath(app) }));
  const defaults: LauncherEntry<App>[] = [];
  for (const builtIn of OS_VIEW_PLACEABLE_BUILTIN_APPS) {
    if (isDefaultAppId(builtIn.appId)) {
      defaults.push({
        kind: "default",
        id: builtIn.appId,
        name: builtIn.name,
        destination: DEFAULT_APP_DESTINATIONS[builtIn.appId],
      });
    } else if (PROMOTED_INSTALL_PATHS.includes(builtIn.appId)) {
      for (const { app, installPath } of located) {
        if (installPath === builtIn.appId) defaults.push(installedEntry(app));
      }
    }
  }
  const others = located
    .filter(({ installPath }) => installPath === null
      || (!PROMOTED_INSTALL_PATHS.includes(installPath) && !REPLACED_INSTALL_PATHS.includes(installPath)))
    .map(({ app }) => installedEntry(app));
  return [...defaults, ...others];
}

/** Case-insensitive match on the name; a blank search keeps every entry. */
export function filterLauncherEntries<Entry extends { name: string }>(
  entries: readonly Entry[],
  query: string,
): Entry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return entries.slice();
  return entries.filter((entry) => entry.name.toLocaleLowerCase().includes(needle));
}

/** Whether the grid lists any web app from the computer, beyond this app's own screens. */
export function hasInstalledApps(entries: readonly LauncherEntry[]): boolean {
  return entries.some((entry) => entry.kind === "installed");
}

/** What the Apps tab says under its grid, if anything. */
export type LauncherStatus = "loading" | "unavailable" | "no-match" | "none-installed";

export function launcherStatus({
  isPending,
  isError,
  entries,
  visibleCount,
  searching,
}: {
  isPending: boolean;
  isError: boolean;
  /** Every entry of the grid, before the search narrows it. */
  entries: readonly LauncherEntry[];
  /** How many entries the search leaves on screen. */
  visibleCount: number;
  searching: boolean;
}): LauncherStatus | null {
  if (isPending) return "loading";
  if (isError) return "unavailable";
  if (visibleCount === 0) return "no-match";
  return searching || hasInstalledApps(entries) ? null : "none-installed";
}

/** The desktop launcher's colours for a default app's icon. */
export function defaultAppColors(id: DefaultAppId): { background: string; foreground: string } {
  const { background, foreground } = OS_VIEW_FIXED_APP_APPEARANCES[id];
  return { background: cssFallbackColor(background), foreground };
}

// The shared appearances are written for CSS, as `var(--token, #hex)` or a
// plain colour. There are no CSS variables here, so the fallback is the colour.
function cssFallbackColor(value: string): string {
  return /^var\(\s*--[\w-]+\s*,\s*([^)]+?)\s*\)$/.exec(value)?.[1] ?? value;
}
