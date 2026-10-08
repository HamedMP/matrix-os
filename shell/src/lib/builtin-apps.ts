import type { LayoutWindow } from "@/hooks/useWindowManager";
import { canonicalOsViewCatalogPath } from "@matrix-os/contracts";
import { useDesktopMode } from "@/stores/desktop-mode";
import { getCodeEditorUrl } from "./feature-flags";
import { resolveWebDesktopBuiltInLaunch } from "./web-desktop-app-launch";

const BUILT_IN_APP_VALUES = [
  "__terminal__",
  "__file-browser__",
  "__chat__",
  "__activity-monitor__",
] as const;

const RETIRED_BUILT_IN_APP_PATHS = new Set(["__workspace__"]);

export const DEFAULT_PINNED_APPS = Object.freeze([] as string[]);
export const TERMINAL_DEFAULT_WINDOW_WIDTH = 1040;
export const TERMINAL_DEFAULT_WINDOW_HEIGHT = 680;
// Terminal collapses its sidebar below 500px; launch size is not a resize limit.
export const TERMINAL_MIN_WINDOW_WIDTH = 440;
export const TERMINAL_MIN_WINDOW_HEIGHT = 300;

const BUILT_IN_APP_ALIASES = new Map<string, string>([
  ["workspace", "__workspace__"],
  ["apps/workspace/index.html", "__workspace__"],
  ["/files/apps/workspace/index.html", "__workspace__"],
  ["terminal", "__terminal__"],
  ["apps/terminal/index.html", "__terminal__"],
  ["/files/apps/terminal/index.html", "__terminal__"],
  ["files", "__file-browser__"],
  ["file-browser", "__file-browser__"],
  ["apps/files/index.html", "__file-browser__"],
  ["/files/apps/files/index.html", "__file-browser__"],
  ["chat", "__chat__"],
  ["apps/chat/index.html", "__chat__"],
  ["/files/apps/chat/index.html", "__chat__"],
  ["activity", "__activity-monitor__"],
  ["activity-monitor", "__activity-monitor__"],
  ["system-activity", "__activity-monitor__"],
  ["apps/activity-monitor/index.html", "__activity-monitor__"],
  ["/files/apps/activity-monitor/index.html", "__activity-monitor__"],
]);

const BUILT_IN_APP_TITLES = new Map<string, string>([
  ["__workspace__", "Workspace"],
  ["__terminal__", "Terminal"],
  ["__file-browser__", "Files"],
  ["__chat__", "Hermes"],
  ["__activity-monitor__", "Activity Monitor"],
]);

export function normalizeBuiltInAppPath(path: string): string {
  if (path.startsWith("__terminal__:")) return "__terminal__";
  return BUILT_IN_APP_ALIASES.get(path) ?? path;
}

/** Bridge directory launches share the HTML identity used by the app catalog. */
export function normalizeAppBridgeLaunchPath(requestedPath: string): string {
  const relativePath = requestedPath.replace(/^\/files\//, "");
  if (relativePath.startsWith("__")) return relativePath;
  const isAppDirectory = /^apps\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*\/?$/.test(relativePath);
  const catalogPath = isAppDirectory ? `${relativePath.replace(/\/$/, "")}/index.html` : relativePath;
  return normalizeBuiltInAppPath(canonicalOsViewCatalogPath({ path: catalogPath }) ?? relativePath);
}

/** App bridges use the same shell-owned destinations as the launcher. */
export function routeAppBridgeLaunch(
  name: string,
  requestedPath: string,
  openWindow: (name: string, path: string) => void,
): void {
  const path = normalizeAppBridgeLaunchPath(requestedPath);
  if (isRetiredBuiltInAppPath(path)) return;
  const destination = resolveWebDesktopBuiltInLaunch(path);
  if (destination?.kind === "external") {
    window.open(destination.url, "_blank", "noopener,noreferrer");
    return;
  }
  if (destination?.kind === "external-code") {
    window.open(getCodeEditorUrl(), "_blank", "noopener,noreferrer");
    return;
  }
  if (destination?.kind === "os-view") {
    useDesktopMode.getState().setMode(destination.mode);
    return;
  }
  openWindow(destination?.kind === "app" ? destination.name : name, destination?.kind === "app" ? destination.path : path);
}

const BUILT_IN_PATHS = new Set<string>(BUILT_IN_APP_VALUES);

export function isBuiltInAppPath(path: string): boolean {
  const normalized = normalizeBuiltInAppPath(path);
  return normalized.startsWith("__terminal__") || BUILT_IN_PATHS.has(normalized) || RETIRED_BUILT_IN_APP_PATHS.has(normalized);
}

export function isRetiredBuiltInAppPath(path: string): boolean {
  return RETIRED_BUILT_IN_APP_PATHS.has(normalizeBuiltInAppPath(path));
}

export function isRestorableBuiltInAppPath(path: string): boolean {
  return isBuiltInAppPath(path) && !isRetiredBuiltInAppPath(path);
}

export function normalizeBuiltInLayoutWindow(window: LayoutWindow): LayoutWindow {
  const path = normalizeBuiltInAppPath(window.path);
  const basePath = path.split(":")[0];
  const title = BUILT_IN_APP_TITLES.get(basePath) ?? window.title;
  const width = basePath === "__terminal__"
    ? Math.max(window.width, TERMINAL_MIN_WINDOW_WIDTH)
    : window.width;
  const height = basePath === "__terminal__"
    ? Math.max(window.height, TERMINAL_MIN_WINDOW_HEIGHT)
    : window.height;
  return path === window.path && title === window.title && width === window.width && height === window.height
    ? window
    : { ...window, path, title, width, height };
}
