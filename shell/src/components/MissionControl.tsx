"use client";

import { useEffect } from "react";
import { useTaskBoard } from "@/hooks/useTaskBoard";
import { AppTile } from "./AppTile";
import {
  XIcon,
  Loader2Icon,
  CheckCircle2Icon,
} from "lucide-react";

interface AppEntry {
  name: string;
  path: string;
  iconUrl?: string;
}

interface MissionControlProps {
  apps: AppEntry[];
  openWindows: Set<string>;
  onOpenApp: (name: string, path: string) => void;
  onClose: () => void;
  pinnedApps: string[];
  onTogglePin: (path: string) => void;
  onRegenerateIcon: (slug: string) => void;
  onRenameApp?: (slug: string, newName: string) => void;
  onDeleteApp?: (slug: string) => void;
}

export function MissionControl({
  apps,
  openWindows,
  onOpenApp,
  onClose,
  pinnedApps,
  onTogglePin,
  onRegenerateIcon,
  onRenameApp,
  onDeleteApp,
}: MissionControlProps) {
  const { provision } = useTaskBoard();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[45]">
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-lg"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      />

      <div className="relative flex flex-col h-full z-10 overflow-hidden md:pl-14">
        <div className="flex items-center justify-between px-6 py-4">
          <h2 className="text-lg font-semibold">Launcher</h2>
          <button
            onClick={onClose}
            className="size-8 flex items-center justify-center rounded-lg hover:bg-muted transition-colors"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {provision.active && (
          <div className="flex items-center gap-2 mx-6 mb-3 px-3 py-1.5 rounded-lg bg-muted/50 text-xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            <span>Building {provision.total} apps...</span>
          </div>
        )}
        {!provision.active && provision.total > 0 && (
          <div className="flex items-center gap-2 mx-6 mb-3 px-3 py-1.5 rounded-lg bg-muted/50 text-xs text-muted-foreground">
            <CheckCircle2Icon className="size-3" />
            <span>
              {provision.succeeded}/{provision.total} apps built
              {provision.failed > 0 && ` (${provision.failed} failed)`}
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="flex flex-wrap gap-1 justify-start">
            {apps.map((app) => {
              const slug = app.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
              return (
                <AppTile
                  key={app.path}
                  name={app.name}
                  isOpen={openWindows.has(app.path)}
                  onClick={() => {
                    onOpenApp(app.name, app.path);
                    onClose();
                  }}
                  pinned={pinnedApps.includes(app.path)}
                  onTogglePin={() => onTogglePin(app.path)}
                  iconUrl={app.iconUrl}
                  onRegenerateIcon={() => onRegenerateIcon(slug)}
                  onRename={onRenameApp ? (newName) => onRenameApp(slug, newName) : undefined}
                  onDelete={onDeleteApp ? () => onDeleteApp(slug) : undefined}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
