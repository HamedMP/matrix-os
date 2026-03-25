"use client";

import { useFileBrowser } from "@/hooks/useFileBrowser";
import { cn } from "@/lib/utils";
import {
  FolderIcon,
  UsersIcon,
  AppWindowIcon,
  SettingsIcon,
  PuzzleIcon,
  BoxIcon,
  DatabaseIcon,
  Trash2Icon,
  StarIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

const LOCATIONS = [
  { name: "Agents", path: "agents", icon: UsersIcon },
  { name: "Apps", path: "apps", icon: AppWindowIcon },
  { name: "System", path: "system", icon: SettingsIcon },
  { name: "Plugins", path: "plugins", icon: PuzzleIcon },
  { name: "Modules", path: "modules", icon: BoxIcon },
  { name: "Data", path: "data", icon: DatabaseIcon },
];

interface FileBrowserSidebarProps {
  onTrashClick: () => void;
  showingTrash: boolean;
}

export function FileBrowserSidebar({ onTrashClick, showingTrash }: FileBrowserSidebarProps) {
  const favorites = useFileBrowser((s) => s.favorites);
  const currentPath = useFileBrowser((s) => s.currentPath);
  const navigate = useFileBrowser((s) => s.navigate);
  const sidebarCollapsed = useFileBrowser((s) => s.sidebarCollapsed);

  if (sidebarCollapsed) return null;

  return (
    <div className="w-44 border-r border-border overflow-y-auto py-2 text-sm shrink-0">
      {favorites.length > 0 && (
        <Section title="Favorites">
          {favorites.map((fav) => (
            <SidebarItem
              key={fav}
              icon={StarIcon}
              label={fav.split("/").pop() ?? fav}
              active={currentPath === fav && !showingTrash}
              onClick={() => navigate(fav)}
            />
          ))}
        </Section>
      )}

      <Section title="Locations">
        <SidebarItem
          icon={FolderIcon}
          label="Home"
          active={currentPath === "" && !showingTrash}
          onClick={() => navigate("")}
        />
        {LOCATIONS.map((loc) => (
          <SidebarItem
            key={loc.path}
            icon={loc.icon}
            label={loc.name}
            active={currentPath === loc.path && !showingTrash}
            onClick={() => navigate(loc.path)}
          />
        ))}
      </Section>

      <Section title="Trash">
        <SidebarItem
          icon={Trash2Icon}
          label="Trash"
          active={showingTrash}
          onClick={onTrashClick}
        />
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {title}
      </div>
      {children}
    </div>
  );
}

function SidebarItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "flex items-center gap-2 w-full px-3 py-1 text-left hover:bg-accent/50 transition-colors rounded-sm",
        active && "bg-accent text-accent-foreground",
      )}
      onClick={onClick}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}
