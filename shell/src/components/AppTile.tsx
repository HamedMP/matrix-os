"use client";

import { PinIcon, RefreshCwIcon } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

interface AppTileProps {
  name: string;
  isOpen: boolean;
  onClick: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  iconUrl?: string;
  onRegenerateIcon?: () => void;
}

export function AppTile({ name, isOpen, onClick, pinned, onTogglePin, iconUrl, onRegenerateIcon }: AppTileProps) {
  const initial = name.charAt(0).toUpperCase();

  const tile = (
    <button
      onClick={onClick}
      className="relative flex flex-col items-center gap-1 p-1.5 rounded-xl hover:bg-accent/50 transition-colors group"
    >
      <div className="relative">
        <div
          className={`flex size-12 items-center justify-center rounded-2xl shadow-sm text-lg font-semibold transition-all ${
            iconUrl
              ? `overflow-hidden ${isOpen ? "ring-2 ring-primary/40 shadow-primary/20 shadow-md" : "group-hover:shadow-md"}`
              : isOpen
                ? "bg-primary/10 border border-primary/40 text-primary shadow-primary/20 shadow-md"
                : "bg-card border border-border/60 text-foreground group-hover:shadow-md"
          }`}
        >
          {iconUrl ? (
            <img src={iconUrl} alt={name} className="size-full object-cover" />
          ) : (
            initial
          )}
        </div>
        {onTogglePin && (
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            className={`absolute -top-1.5 -right-1.5 z-10 size-5 flex items-center justify-center rounded-full border transition-all cursor-pointer ${
              pinned
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-muted-foreground border-border opacity-0 group-hover:opacity-100"
            }`}
            title={pinned ? "Unpin from dock" : "Pin to dock"}
          >
            <PinIcon className="size-2.5" />
          </span>
        )}
      </div>
      <span className="text-[11px] text-muted-foreground truncate max-w-[72px]">
        {name}
      </span>
      {isOpen && (
        <span className="size-1.5 rounded-full bg-primary" />
      )}
    </button>
  );

  if (!onTogglePin && !onRegenerateIcon) return tile;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {tile}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {onTogglePin && (
          <ContextMenuItem onSelect={onTogglePin}>
            <PinIcon className="size-3.5 mr-2" />
            {pinned ? "Unpin from Dock" : "Pin to Dock"}
          </ContextMenuItem>
        )}
        {onRegenerateIcon && (
          <ContextMenuItem onSelect={onRegenerateIcon}>
            <RefreshCwIcon className="size-3.5 mr-2" />
            Regenerate Icon
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
