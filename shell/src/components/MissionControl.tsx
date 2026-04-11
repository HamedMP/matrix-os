"use client";

import { useEffect, useState, useRef } from "react";
import { useTaskBoard } from "@/hooks/useTaskBoard";
import { nameToSlug } from "@/lib/utils";
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
  open: boolean;
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
  open,
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
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const closingRef = useRef(false);

  const prevOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (open && !wasOpen) {
      closingRef.current = false;
      setMounted(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
    } else if (!open && wasOpen) {
      closingRef.current = true;
      setVisible(false);
      const timer = setTimeout(() => {
        setMounted(false);
        closingRef.current = false;
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mounted, onClose]);

  if (!mounted) return null;

  return (
    <div data-mission-control className="fixed inset-0 z-[45]">
      <div
        data-mission-backdrop
        className="absolute inset-0 bg-black/30 transition-all duration-300 ease-out"
        style={{
          backdropFilter: visible ? "blur(24px)" : "blur(0px)",
          opacity: visible ? 1 : 0,
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      />

      <div
        className="relative flex flex-col h-full z-10 overflow-hidden md:pl-14 pt-16 transition-all duration-300 ease-out"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? "scale(1) translateY(0)" : "scale(0.97) translateY(12px)",
        }}
      >
        <div className="flex items-center justify-between px-6 py-4">
          <h2 className="text-lg font-semibold text-white">Launcher</h2>
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
            {apps.map((app, index) => {
              const slug = nameToSlug(app.name);
              return (
                <div
                  key={app.path}
                  className="transition-all duration-300 ease-out"
                  style={{
                    opacity: visible ? 1 : 0,
                    transform: visible ? "translateY(0)" : "translateY(16px)",
                    transitionDelay: closingRef.current ? "0ms" : `${50 + index * 20}ms`,
                  }}
                >
                  <AppTile
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
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
