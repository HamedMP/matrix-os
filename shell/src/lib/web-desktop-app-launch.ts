import type { AppEntry } from "@/hooks/useWindowManager";
import type { DesktopMode } from "@/stores/desktop-mode";
import { iconUrlForSlug } from "@/lib/app-launch";
import {
  DEFAULT_OS_VIEW_DESKTOP_APP_PATHS,
  OS_VIEW_DESTINATION_PATHS,
  OS_VIEW_LABELS,
  isOsViewDestinationPath,
  otherOsViewMode,
} from "@matrix-os/contracts";

export type WebDesktopBuiltInLaunch =
  | { kind: "external"; url: string }
  | { kind: "external-code" }
  | { kind: "os-view"; mode: DesktopMode }
  | { kind: "app"; name: string; path: string };

export { isOsViewDestinationPath };

export function resolveWebDesktopBuiltInLaunch(path: string): WebDesktopBuiltInLaunch | null {
  if (
    path === "__browser__"
    || path === "apps/browser/index.html"
    || path === "apps/browser/dist/index.html"
  ) {
    return { kind: "external", url: "https://www.google.com" };
  }
  if (path === "__vscode__") {
    return { kind: "external-code" };
  }
  if (path === "__editor__") {
    return { kind: "app", name: "Files", path: "__file-browser__" };
  }
  if (path === OS_VIEW_DESTINATION_PATHS.canvas) {
    return { kind: "os-view", mode: "canvas" };
  }
  if (path === OS_VIEW_DESTINATION_PATHS.desktop) {
    return { kind: "os-view", mode: "desktop" };
  }
  return null;
}

function findCanonicalApp(apps: readonly AppEntry[], paths: readonly string[]): AppEntry | undefined {
  return apps.find((app) => paths.includes(app.path));
}

function namedDesktopApp(app: AppEntry | undefined, fallback: AppEntry): AppEntry {
  return app ? { ...app, name: fallback.name } : fallback;
}

export function buildWebDesktopIconApps(apps: readonly AppEntry[]): AppEntry[] {
  const chat = findCanonicalApp(apps, ["__chat__"]);
  const browserPaths = ["__browser__", "apps/browser/index.html", "apps/browser/dist/index.html"];
  const notesPaths = ["apps/notes/index.html", "apps/notes/dist/index.html"];
  const whiteboardPaths = ["apps/whiteboard/index.html", "apps/whiteboard/dist/index.html"];
  const firstClass: AppEntry[] = [
    chat ? { ...chat, name: "Chat" } : { name: "Chat", path: "__chat__" },
    findCanonicalApp(apps, ["__terminal__"]) ?? { name: "Terminal", path: "__terminal__" },
    findCanonicalApp(apps, ["__file-browser__"]) ?? { name: "Files", path: "__file-browser__" },
    { name: "Editor", path: "__editor__" },
    { name: "VS Code", path: "__vscode__", iconUrl: "/vscode.png" },
    { name: "Settings", path: "__settings__" },
    { name: "Plugins", path: "__plugins__" },
    namedDesktopApp(findCanonicalApp(apps, browserPaths), { name: "Browser", path: "__browser__" }),
    namedDesktopApp(findCanonicalApp(apps, notesPaths), { name: "Notes", path: "apps/notes/index.html" }),
    namedDesktopApp(findCanonicalApp(apps, whiteboardPaths), { name: "Whiteboard", path: "apps/whiteboard/index.html" }),
  ];
  const firstClassPaths = new Set([
    ...DEFAULT_OS_VIEW_DESKTOP_APP_PATHS,
    ...browserPaths,
    ...notesPaths,
    ...whiteboardPaths,
  ]);
  return [...firstClass, ...apps.filter((app) => !firstClassPaths.has(app.path))];
}

export function buildWebDesktopLauncherApps(
  apps: readonly AppEntry[],
  currentMode: DesktopMode = "desktop",
): AppEntry[] {
  const destinationMode = otherOsViewMode(currentMode);
  const viewDestination: AppEntry = {
    name: `Web ${OS_VIEW_LABELS[destinationMode]}`,
    path: OS_VIEW_DESTINATION_PATHS[destinationMode],
    iconUrl: iconUrlForSlug(destinationMode),
  };
  return [viewDestination, ...buildWebDesktopIconApps(apps)];
}
