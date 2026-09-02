import {
  Blocks,
  BrushIcon,
  Code2,
  FilePenLine,
  FolderTree,
  Globe2,
  MessageSquare,
  Notebook,
  Settings,
  SquareTerminal,
  type LucideIcon,
} from "@renderer/lib/hugeicons";
import type { TabKind } from "../../stores/tabs";
import { OS_VIEW_FIXED_APP_APPEARANCES } from "@matrix-os/contracts";
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
  | "notes"
  | "whiteboard";

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
    kind: "work",
    icon: MessageSquare,
    name: "Chat",
    color: APPEARANCE.chat.background,
    iconColor: APPEARANCE.chat.foreground,
  },
  {
    id: "terminal",
    path: "__terminal__",
    kind: "terminals",
    icon: SquareTerminal,
    name: "Terminal",
    color: APPEARANCE.terminal.background,
    iconColor: APPEARANCE.terminal.foreground,
  },
  {
    id: "files",
    path: "__file-browser__",
    kind: "files",
    icon: FolderTree,
    name: "Files",
    color: APPEARANCE.files.background,
    iconColor: APPEARANCE.files.foreground,
  },
  {
    id: "editor",
    path: "__editor__",
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
    kind: "settings",
    icon: Settings,
    name: "Settings",
    color: APPEARANCE.settings.background,
    iconColor: APPEARANCE.settings.foreground,
  },
  {
    id: "plugins",
    path: "__plugins__",
    kind: "settings",
    icon: Blocks,
    name: "Plugins",
    color: APPEARANCE.plugins.background,
    iconColor: APPEARANCE.plugins.foreground,
    settingsSection: "services",
  },
  {
    id: "browser",
    path: "__browser__",
    kind: "browser",
    icon: Globe2,
    name: "Browser",
    color: APPEARANCE.browser.background,
    iconColor: APPEARANCE.browser.foreground,
  },
  {
    id: "notes",
    path: "apps/notes/index.html",
    kind: "notes",
    icon: Notebook,
    name: "Notes",
    color: APPEARANCE.notes.background,
    iconColor: APPEARANCE.notes.foreground,
  },
  {
    id: "whiteboard",
    path: "apps/whiteboard/index.html",
    kind: "app",
    icon: BrushIcon,
    name: "Whiteboard",
    color: APPEARANCE.whiteboard.background,
    iconColor: APPEARANCE.whiteboard.foreground,
    slug: "whiteboard",
  },
];

export function desktopAppAppearance(kind: TabKind): Pick<DesktopAppConfig, "color" | "iconColor"> {
  const app = FIXED_DESKTOP_APPS.find((candidate) => candidate.kind === kind)
    ?? (kind === "terminal" ? FIXED_DESKTOP_APPS.find((candidate) => candidate.id === "terminal") : undefined);
  return { color: app?.color, iconColor: app?.iconColor };
}
