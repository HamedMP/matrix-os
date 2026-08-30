import type { AppEntry } from "@/hooks/useWindowManager";
import type { DesktopMode } from "@/stores/desktop-mode";
import { iconUrlForSlug } from "@/lib/app-launch";
import {
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

export function buildWebDesktopIconApps(apps: readonly AppEntry[]): AppEntry[] {
  const chat = findCanonicalApp(apps, ["__chat__"]);
  const firstClass: AppEntry[] = [
    chat ? { ...chat, name: "Chat" } : { name: "Chat", path: "__chat__" },
    findCanonicalApp(apps, ["__terminal__"]) ?? { name: "Terminal", path: "__terminal__" },
    findCanonicalApp(apps, ["__file-browser__"]) ?? { name: "Files", path: "__file-browser__" },
    { name: "Editor", path: "__editor__" },
    { name: "VS Code", path: "__vscode__", iconUrl: "/vscode.png" },
    { name: "Settings", path: "__settings__" },
    { name: "Plugins", path: "__plugins__" },
    findCanonicalApp(apps, ["apps/browser/index.html", "apps/browser/dist/index.html"])
      ?? { name: "Browser", path: "__browser__" },
    findCanonicalApp(apps, ["apps/notes/index.html", "apps/notes/dist/index.html"])
      ?? { name: "Notes", path: "apps/notes/index.html" },
    findCanonicalApp(apps, ["apps/whiteboard/index.html", "apps/whiteboard/dist/index.html"])
      ?? { name: "Whiteboard", path: "apps/whiteboard/index.html" },
  ];
  const firstClassPaths = new Set(firstClass.map((app) => app.path));
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
