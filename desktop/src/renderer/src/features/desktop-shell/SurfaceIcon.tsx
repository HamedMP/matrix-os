import {
  Blocks,
  FileCode2,
  FilePenLine,
  Code2,
  FolderKanban,
  FolderTree,
  Globe2,
  LayoutGrid,
  MessageCircle,
  Notebook,
  Settings,
  SquareTerminal,
  UsersIcon,
  type LucideIcon,
} from "@renderer/lib/hugeicons";
import { bundledDesktopIconForPath } from "./bundled-app-icons";
import { useState } from "react";
import type { Tab, TabKind } from "../../stores/tabs";

const SURFACE_ICON: Record<TabKind, LucideIcon> = {
  home: Globe2,
  browser: Globe2,
  work: FolderKanban,
  chat: MessageCircle,
  projects: FolderKanban,
  project: FolderKanban,
  task: FileCode2,
  terminal: SquareTerminal,
  terminals: SquareTerminal,
  files: FolderTree,
  editor: FilePenLine,
  vscode: Code2,
  notes: Notebook,
  apps: LayoutGrid,
  app: LayoutGrid,
  settings: Settings,
  shared: UsersIcon,
};

export default function SurfaceIcon({
  tab,
  size = 18,
}: {
  tab: Pick<Tab, "kind" | "icon" | "title">;
  size?: number;
}) {
  // Plugins and Settings reuse one settings surface; its title identifies the
  // current destination without retaining stale bundled artwork on the tab.
  const isPlugins = tab.kind === "settings" && tab.title === "Plugins";
  const Icon = isPlugins ? Blocks : SURFACE_ICON[tab.kind];
  const explicitIcon = tab.icon && /^(?:https?:\/\/|\/|data:image\/)/.test(tab.icon) ? tab.icon : null;
  const paths: Partial<Record<TabKind,string>> = { home: "__browser__", browser: "__browser__", work: "__chat__", chat: "__chat__", terminal: "__terminal__", terminals: "__terminal__", files: "__file-browser__", editor: "__editor__", notes: "apps/notes/index.html", settings: "__settings__" };
  const path = isPlugins ? "__plugins__" : paths[tab.kind];
  const iconUrl = explicitIcon ?? (path ? bundledDesktopIconForPath(path) : undefined);
  if (iconUrl) return <RemoteSurfaceIcon key={iconUrl} iconUrl={iconUrl} size={size} fallback={Icon} />;
  return <Icon size={size} aria-hidden="true" />;
}

function RemoteSurfaceIcon({
  iconUrl,
  size,
  fallback: Fallback,
}: {
  iconUrl: string;
  size: number;
  fallback: LucideIcon;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Fallback size={size} aria-hidden="true" />;
  return (
    <img
      src={iconUrl}
      alt=""
      width={size}
      height={size}
      className="shrink-0 object-contain"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export function surfaceIconTab(kind: TabKind, title: string): Pick<Tab, "kind" | "title"> {
  return { kind, title };
}
