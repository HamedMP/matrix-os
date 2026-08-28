import {
  Blocks,
  FolderTree,
  Globe2,
  MessageSquare,
  Settings,
  SquareTerminal,
  type LucideIcon,
} from "@renderer/lib/hugeicons";
import type { TabKind } from "../../stores/tabs";

export type DesktopAppId = "browser" | "work" | "terminal" | "files" | "plugins" | "settings";

export interface DesktopAppConfig {
  id: DesktopAppId;
  kind: TabKind;
  icon: LucideIcon;
  name: string;
  color?: string;
  iconColor?: string;
}

export const FIXED_DESKTOP_APPS: readonly DesktopAppConfig[] = [
  {
    id: "browser",
    kind: "home",
    icon: Globe2,
    name: "Browser",
    color: "var(--surface-info-emphasis, #3B85BA)",
    iconColor: "white",
  },
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
    id: "plugins",
    kind: "plugins",
    icon: Blocks,
    name: "Plugins",
    color: "#7C6DB4",
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
];

export function desktopAppAppearance(kind: TabKind): Pick<DesktopAppConfig, "color" | "iconColor"> {
  const app = FIXED_DESKTOP_APPS.find((candidate) => candidate.kind === kind)
    ?? (kind === "terminal" ? FIXED_DESKTOP_APPS.find((candidate) => candidate.id === "terminal") : undefined);
  return { color: app?.color, iconColor: app?.iconColor };
}
