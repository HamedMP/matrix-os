import type { OsViewMode, OsViewStatePatch, OsViewWindowGeometry } from "@matrix-os/contracts";
import type { MatrixApp } from "../apps/apps.api";
import type { DesktopSurface } from "../../stores/desktop-surfaces";
import type { Tab } from "../../stores/tabs";
import { FIXED_DESKTOP_APPS, GETTING_STARTED_DESKTOP_APP } from "./desktop-apps";
import { nativeBrowserProduct } from "../../../../shared/browser-products";

export function nativeTabOsViewPath(tab: Tab, installedApps: readonly MatrixApp[]): string | null {
  if (tab.kind === "terminal" && tab.sessionName) return `__terminal__:${tab.sessionName}`;
  if (tab.kind === "app" && tab.slug) {
    const product = nativeBrowserProduct(tab.appIdentity ?? "", tab.slug);
    if (product) return product.path;
    return installedApps.find((app) => app.slug === tab.slug)?.path
      ?? FIXED_DESKTOP_APPS.find((app) => app.slug === tab.slug)?.path
      ?? null;
  }
  // Generic embedded browser tabs retain their own local tab history; their
  // URLs must not restore as the distinct VPS Chrome destination.
  if (tab.kind === "browser") return null;
  if (tab.kind === "settings" && (tab.title === "Plugins" || tab.title === "Connect Apps")) return "__plugins__";
  return [...FIXED_DESKTOP_APPS, GETTING_STARTED_DESKTOP_APP].find((app) => app.kind === tab.kind)?.path
    ?? (tab.kind === "terminal" ? "__terminal__" : null);
}

function appState(surface: DesktopSurface): "open" | "minimized" | "closed" {
  if (surface.mode === "closed") return "closed";
  if (surface.mode === "minimized") return "minimized";
  return "open";
}

export function nativeOsViewPatch(input: {
  tabs: readonly Tab[];
  surfaces: Readonly<Record<string, DesktopSurface>>;
  installedApps: readonly MatrixApp[];
  mode: OsViewMode;
  canonicalGeometry: Readonly<Record<string, Omit<OsViewWindowGeometry, "path">>>;
  canvasTransform?: { panX: number; panY: number; zoom: number };
}): OsViewStatePatch {
  const entries = input.tabs.flatMap((tab) => {
    const surface = input.surfaces[tab.id];
    const path = nativeTabOsViewPath(tab, input.installedApps);
    if (!surface || !path) return [];
    const bounds = input.canonicalGeometry[path] ?? surface.bounds;
    return [{
      app: { path, title: tab.title, state: appState(surface) },
      geometry: { path, ...bounds },
    }];
  });
  return {
    apps: entries.map((entry) => entry.app),
    ...(input.mode === "canvas"
      ? {
          canvas: {
            windows: entries.map((entry) => entry.geometry),
            ...(input.canvasTransform ? { transform: input.canvasTransform } : {}),
          },
        }
      : { desktop: { windows: entries.map((entry) => entry.geometry) } }),
  };
}
