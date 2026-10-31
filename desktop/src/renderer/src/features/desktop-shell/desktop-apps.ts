import {
  Blocks,
  BrushIcon,
  Code2,
  Rocket,
  FilePenLine,
  FolderTree,
  Globe2,
  Monitor,
  MessageSquare,
  Notebook,
  Settings,
  SquareTerminal,
  type LucideIcon,
} from "@renderer/lib/hugeicons";
import type { TabKind } from "../../stores/tabs";
import { OS_VIEW_FIXED_APP_APPEARANCES } from "@matrix-os/contracts";
import { bundledDesktopIconForPath } from "./bundled-app-icons";
import vscodeIconUrl from "../../../../../../shell/public/vscode.png";

const APPEARANCE = OS_VIEW_FIXED_APP_APPEARANCES;

export type DesktopAppId =
  | "work"
  | "terminal"
  | "files"
  | "editor"
  | "vscode"
  | "settings"
  | "plugins"
  | "browser"
  | "cloud-desktop"
  | "notes"
  | "whiteboard"
  | "getting-started";

export interface DesktopAppConfig {
  id: DesktopAppId;
  path: string;
  kind: TabKind;
  icon: LucideIcon;
  name: string;
  color?: string;
  iconColor?: string;
  iconUrl?: string;
  settingsSection?: "services";
  slug?: "whiteboard";
}

export const FIXED_DESKTOP_APPS: readonly DesktopAppConfig[] = [
  {
    id: "work",
    path: "__chat__",
    iconUrl: bundledDesktopIconForPath("__chat__"),
    kind: "work",
    icon: MessageSquare,
    name: "Chat",
    color: APPEARANCE.chat.background,
    iconColor: APPEARANCE.chat.foreground,
  },
  {
    id: "terminal",
    path: "__terminal__",
    iconUrl: bundledDesktopIconForPath("__terminal__"),
    kind: "terminals",
    icon: SquareTerminal,
    name: "Terminal",
    color: APPEARANCE.terminal.background,
    iconColor: APPEARANCE.terminal.foreground,
  },
  {
    id: "files",
    path: "__file-browser__",
    iconUrl: bundledDesktopIconForPath("__file-browser__"),
    kind: "files",
    icon: FolderTree,
    name: "Files",
    color: APPEARANCE.files.background,
    iconColor: APPEARANCE.files.foreground,
  },
  {
    id: "editor",
    path: "__editor__",
    iconUrl: bundledDesktopIconForPath("__editor__"),
    kind: "editor",
    icon: FilePenLine,
    name: "Editor",
    color: APPEARANCE.editor.background,
    iconColor: APPEARANCE.editor.foreground,
  },
  {
    id: "vscode",
    path: "__vscode__",
    kind: "vscode",
    icon: Code2,
    iconUrl: vscodeIconUrl,
    name: "VS Code",
    color: APPEARANCE.vscode.background,
    iconColor: APPEARANCE.vscode.foreground,
  },
  {
    id: "settings",
    path: "__settings__",
    iconUrl: bundledDesktopIconForPath("__settings__"),
    kind: "settings",
    icon: Settings,
    name: "Settings",
    color: APPEARANCE.settings.background,
    iconColor: APPEARANCE.settings.foreground,
  },
  {
    id: "plugins",
    path: "__plugins__",
    iconUrl: bundledDesktopIconForPath("__plugins__"),
    kind: "settings",
    icon: Blocks,
    name: "Connect Apps",
    color: APPEARANCE.plugins.background,
    iconColor: APPEARANCE.plugins.foreground,
    settingsSection: "services",
  },
  {
    id: "browser",
    path: "__browser__",
    iconUrl: bundledDesktopIconForPath("__browser__"),
    kind: "app",
    icon: Globe2,
    name: "Browser",
    color: APPEARANCE.browser.background,
    iconColor: APPEARANCE.browser.foreground,
  },
  {
    id: "cloud-desktop", path: "__cloud-desktop__", kind: "app", icon: Monitor,
    name: "Cloud desktop", iconUrl: bundledDesktopIconForPath("__cloud-desktop__"),
    color: APPEARANCE.browser.background, iconColor: APPEARANCE.browser.foreground,
  },
  {
    id: "notes",
    path: "apps/notes/index.html",
    iconUrl: bundledDesktopIconForPath("apps/notes/index.html"),
    kind: "notes",
    icon: Notebook,
    name: "Notes",
    color: APPEARANCE.notes.background,
    iconColor: APPEARANCE.notes.foreground,
  },
  {
    id: "whiteboard",
    path: "apps/whiteboard/index.html",
    iconUrl: bundledDesktopIconForPath("apps/whiteboard/index.html"),
    kind: "app",
    icon: BrushIcon,
    name: "Whiteboard",
    color: APPEARANCE.whiteboard.background,
    iconColor: APPEARANCE.whiteboard.foreground,
    slug: "whiteboard",
  },
];

/**
 * Spec 639: the Getting started app is not a default desktop destination
 * (FIXED_DESKTOP_APPS mirrors DEFAULT_OS_VIEW_DESKTOP_APP_PATHS). Surfaces add
 * it only while this computer serves the app.
 */
export const GETTING_STARTED_DESKTOP_APP: DesktopAppConfig = {
  id: "getting-started",
  path: "__getting-started__",
  iconUrl: bundledDesktopIconForPath("__getting-started__"),
  kind: "getting-started",
  icon: Rocket,
  name: "Getting started",
  color: APPEARANCE["getting-started"].background,
  iconColor: APPEARANCE["getting-started"].foreground,
};

/**
 * Startup restore waits for the app catalog and for whether this computer serves Getting started,
 * so a saved Getting started window is not skipped when that check lands after restore.
 */
export function desktopStartupCatalogSettled({ appsLoading, gettingStartedApp }: {
  appsLoading: boolean;
  /** The Getting started provider's availability; null outside a provider. */
  gettingStartedApp: "checking" | "enabled" | "unavailable" | null;
}): boolean {
  return !appsLoading && gettingStartedApp !== "checking";
}

/** Desktop destinations for this computer: the defaults, plus Getting started when it is served. */
export function desktopAppsFor({ gettingStartedApp }: { gettingStartedApp: boolean }): readonly DesktopAppConfig[] {
  return gettingStartedApp ? [...FIXED_DESKTOP_APPS, GETTING_STARTED_DESKTOP_APP] : FIXED_DESKTOP_APPS;
}

export function desktopAppAppearance(kind: TabKind): Pick<DesktopAppConfig, "color" | "iconColor"> {
  const app = [...FIXED_DESKTOP_APPS, GETTING_STARTED_DESKTOP_APP].find((candidate) => candidate.kind === kind)
    ?? (kind === "terminal" ? FIXED_DESKTOP_APPS.find((candidate) => candidate.id === "terminal") : undefined);
  return { color: app?.color, iconColor: app?.iconColor };
}
