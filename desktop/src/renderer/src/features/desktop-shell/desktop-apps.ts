import {
  Blocks,
  BrushIcon,
  FileText,
  FolderTree,
  Globe2,
  MessageSquare,
  Settings,
  SquareTerminal,
  type LucideIcon,
} from "@renderer/lib/hugeicons";
import type { TabKind } from "../../stores/tabs";

export type DesktopAppId =
  | "work"
  | "terminal"
  | "files"
  | "settings"
  | "plugins"
  | "browser"
  | "notes"
  | "whiteboard";

export interface DesktopAppConfig {
  id: DesktopAppId;
  kind: TabKind;
  icon: LucideIcon;
  name: string;
  color?: string;
  iconColor?: string;
  settingsSection?: "skills";
  slug?: "notes" | "whiteboard";
}

export const FIXED_DESKTOP_APPS: readonly DesktopAppConfig[] = [
  {
    id: "work",
    kind: "work",
    icon: MessageSquare,
    name: "Chat",
    color: "var(--surface-error-emphasis, #BA5236)",
    iconColor: "white",
  },
  {
    id: "terminal",
    kind: "terminals",
    icon: SquareTerminal,
    name: "Terminal",
    color: "var(--surface-warning-emphasis, #E0AA52)",
    iconColor: "white",
  },
  {
    id: "files",
    kind: "files",
    icon: FolderTree,
    name: "Files",
    color: "var(--surface-brand-emphasis, #748E59)",
    iconColor: "white",
  },
  {
    id: "settings",
    kind: "settings",
    icon: Settings,
    name: "Settings",
    color: "var(--surface-neutral-emphasis, #6B7280)",
    iconColor: "white",
  },
  {
    id: "plugins",
    kind: "settings",
    icon: Blocks,
    name: "Plugins",
    color: "#7C6DB4",
    iconColor: "white",
    settingsSection: "skills",
  },
  {
    id: "browser",
    kind: "browser",
    icon: Globe2,
    name: "Browser",
    color: "var(--surface-info-emphasis, #3B85BA)",
    iconColor: "white",
  },
  {
    id: "notes",
    kind: "app",
    icon: FileText,
    name: "Notes",
    color: "#E3B341",
    iconColor: "white",
    slug: "notes",
  },
  {
    id: "whiteboard",
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
