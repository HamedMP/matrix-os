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
import {
  SYSTEM_DESKTOP_APPS,
  type SystemDesktopAppIconKey,
  type SystemDesktopAppId,
} from "@matrix-os/contracts";
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

const ICON_BY_KEY: Record<SystemDesktopAppIconKey, LucideIcon> = {
  "message-square": MessageSquare,
  "square-terminal": SquareTerminal,
  "folder-tree": FolderTree,
  "file-pen-line": FilePenLine,
  "code-2": Code2,
  settings: Settings,
  blocks: Blocks,
  "globe-2": Globe2,
  notebook: Notebook,
  brush: BrushIcon,
};

const DESKTOP_RUNTIME_BY_ID = {
  chat: { id: "work", path: "__chat__", kind: "work" },
  terminal: { id: "terminal", path: "__terminal__", kind: "terminals" },
  files: { id: "files", path: "__file-browser__", kind: "files" },
  editor: { id: "editor", path: "__editor__", kind: "editor" },
  vscode: { id: "vscode", path: "__vscode__", kind: "vscode", iconUrl: vscodeIconUrl },
  settings: { id: "settings", path: "__settings__", kind: "settings" },
  plugins: { id: "plugins", path: "__plugins__", kind: "settings", settingsSection: "services" },
  browser: { id: "browser", path: "__browser__", kind: "browser" },
  notes: { id: "notes", path: "__notes__", kind: "notes" },
  whiteboard: { id: "whiteboard", path: "apps/whiteboard/index.html", kind: "app", slug: "whiteboard" },
} as const satisfies Record<SystemDesktopAppId, Omit<DesktopAppConfig, "icon" | "name" | "color" | "iconColor">>;

export const FIXED_DESKTOP_APPS: readonly DesktopAppConfig[] = SYSTEM_DESKTOP_APPS.map((definition) => ({
  ...DESKTOP_RUNTIME_BY_ID[definition.id],
  icon: ICON_BY_KEY[definition.iconKey],
  name: definition.name,
  color: definition.color,
  iconColor: definition.iconColor,
}));

export function desktopAppAppearance(kind: TabKind): Pick<DesktopAppConfig, "color" | "iconColor"> {
  const app = FIXED_DESKTOP_APPS.find((candidate) => candidate.kind === kind)
    ?? (kind === "terminal" ? FIXED_DESKTOP_APPS.find((candidate) => candidate.id === "terminal") : undefined);
  return { color: app?.color, iconColor: app?.iconColor };
}
