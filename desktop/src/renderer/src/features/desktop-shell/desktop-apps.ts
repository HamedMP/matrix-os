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
import vscodeIconUrl from "../../../../../../shell/public/vscode.png";

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
    color: "var(--surface-error-emphasis, #BA5236)",
    iconColor: "white",
  },
  {
    id: "terminal",
    path: "__terminal__",
    kind: "terminals",
    icon: SquareTerminal,
    name: "Terminal",
    color: "var(--surface-warning-emphasis, #E0AA52)",
    iconColor: "white",
  },
  {
    id: "files",
    path: "__file-browser__",
    kind: "files",
    icon: FolderTree,
    name: "Files",
    color: "var(--surface-brand-emphasis, #748E59)",
    iconColor: "white",
  },
  {
    id: "editor",
    path: "__editor__",
    kind: "editor",
    icon: FilePenLine,
    name: "Editor",
    color: "#4D7FA8",
    iconColor: "white",
  },
  {
    id: "vscode",
    path: "__vscode__",
    kind: "vscode",
    icon: Code2,
    iconUrl: vscodeIconUrl,
    name: "VS Code",
    color: "#FFFEFC",
    iconColor: "#007ACC",
  },
  {
    id: "settings",
    path: "__settings__",
    kind: "settings",
    icon: Settings,
    name: "Settings",
    color: "var(--surface-neutral-emphasis, #6B7280)",
    iconColor: "white",
  },
  {
    id: "plugins",
    path: "__plugins__",
    kind: "settings",
    icon: Blocks,
    name: "Plugins",
    color: "#7C6DB4",
    iconColor: "white",
    settingsSection: "services",
  },
  {
    id: "browser",
    path: "__browser__",
    kind: "browser",
    icon: Globe2,
    name: "Browser",
    color: "var(--surface-info-emphasis, #3B85BA)",
    iconColor: "white",
  },
  {
    id: "notes",
    path: "__notes__",
    kind: "notes",
    icon: Notebook,
    name: "Notes",
    color: "var(--surface-purple-emphasis)",
    iconColor: "white",
  },
  {
    id: "whiteboard",
    path: "apps/whiteboard/index.html",
    kind: "app",
    icon: BrushIcon,
    name: "Whiteboard",
    color: "#D46A92",
    iconColor: "white",
    slug: "whiteboard",
  },
];

export function desktopAppAppearance(kind: TabKind): Pick<DesktopAppConfig, "color" | "iconColor"> {
  const app = FIXED_DESKTOP_APPS.find((candidate) => candidate.kind === kind)
    ?? (kind === "terminal" ? FIXED_DESKTOP_APPS.find((candidate) => candidate.id === "terminal") : undefined);
  return { color: app?.color, iconColor: app?.iconColor };
}
