import {
  Blocks,
  FileCode2,
  FolderKanban,
  FolderTree,
  Globe2,
  LayoutGrid,
  MessageCircle,
  Settings,
  SquareTerminal,
  type LucideIcon,
} from "@renderer/lib/hugeicons";
import { useState } from "react";
import type { Tab, TabKind } from "../../stores/tabs";

const SURFACE_ICON: Record<TabKind, LucideIcon> = {
  home: Globe2,
  chat: MessageCircle,
  projects: FolderKanban,
  project: FolderKanban,
  task: FileCode2,
  terminal: SquareTerminal,
  terminals: SquareTerminal,
  files: FolderTree,
  apps: LayoutGrid,
  app: LayoutGrid,
  plugins: Blocks,
  settings: Settings,
};

export default function SurfaceIcon({
  tab,
  size = 18,
}: {
  tab: Pick<Tab, "kind" | "icon" | "title">;
  size?: number;
}) {
  const Icon = SURFACE_ICON[tab.kind];
  const iconUrl = tab.icon && /^https?:\/\//.test(tab.icon) ? tab.icon : null;
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
      className="shrink-0 rounded-[22%] object-cover"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export function surfaceIconTab(kind: TabKind, title: string): Pick<Tab, "kind" | "title"> {
  return { kind, title };
}
