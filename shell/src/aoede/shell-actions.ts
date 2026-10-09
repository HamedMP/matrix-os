import { findAppByName } from "@/components/desktop/desktop-app-routing";
import { resolveWebDesktopBuiltInLaunch } from "@/lib/web-desktop-app-launch";

type App = { name: string; path: string; slug?: string };
export type UiResult = { status: "ok" | "ambiguous" | "not_found" | "failed"; slug?: string };
export function resolveAoedeApp(apps: App[], query: string): UiResult {
  // Reuse Desktop's fuzzy rules but never choose silently between candidates.
  const exact = apps.filter((app) => app.name.toLowerCase() === query.trim().toLowerCase());
  const matches = exact.length ? exact : apps.filter((app) => findAppByName([app], query));
  if (matches.length > 1) return { status: "ambiguous" };
  const match = findAppByName(matches, query);
  return match?.slug ? { status: "ok", slug: match.slug } : { status: "not_found" };
}
export function executeAoedeApp(
  apps: App[], slug: string, action: "open_app" | "close_app",
  open: (path: string, name: string) => void, close: (id: string) => void,
  windows: () => { id: string; path: string; minimized: boolean }[],
): UiResult {
  const app = apps.find((app) => app.slug === slug);
  if (!app) return { status: "not_found" };
  const launch = resolveWebDesktopBuiltInLaunch(app.path);
  // External tabs and mode changes have no inspectable app-window outcome.
  if (launch && launch.kind !== "app") return { status: "failed" };
  const path = launch?.path ?? app.path;
  if (action === "open_app") open(app.path, app.name);
  else {
    const current = windows().filter((win) => win.path === path);
    if (!current.length) return { status: "not_found" };
    current.forEach((win) => close(win.id));
  }
  const present = windows().some((win) => win.path === path && (action === "close_app" || !win.minimized));
  return present === (action === "open_app") ? { status: "ok", slug } : { status: "failed" };
}
