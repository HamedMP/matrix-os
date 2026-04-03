"use client";

import { useState, useRef } from "react";
import { PinIcon, RefreshCwIcon, PencilIcon, TrashIcon } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
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
  onRename?: (newName: string) => void;
  onDelete?: () => void;
}

export function AppTile({ name, isOpen, onClick, pinned, onTogglePin, iconUrl, onRegenerateIcon, onRename, onDelete }: AppTileProps) {
  const initial = name.charAt(0).toUpperCase();
  const [imgFailed, setImgFailed] = useState(false);
  const prevIconUrl = useRef(iconUrl);
  if (iconUrl !== prevIconUrl.current) {
    prevIconUrl.current = iconUrl;
    if (imgFailed) setImgFailed(false);
  }
  const showIcon = iconUrl && !imgFailed;

  const tile = (
    <button
      onClick={onClick}
      className="relative flex flex-col items-center gap-1.5 p-1.5 rounded-xl hover:bg-accent/50 transition-colors group"
    >
      <div className="relative">
        <div
          className={`flex size-24 items-center justify-center rounded-[22px] shadow-sm text-2xl font-semibold transition-all ${
            showIcon
              ? `overflow-hidden ${isOpen ? "ring-2 ring-primary/40 shadow-primary/20 shadow-md" : "group-hover:shadow-md"}`
              : isOpen
                ? "bg-primary/10 border border-primary/40 text-primary shadow-primary/20 shadow-md"
                : "bg-card border border-border/60 text-foreground group-hover:shadow-md"
          }`}
        >
          {showIcon ? (
            <img src={iconUrl} alt={name} className="w-[115%] h-[115%] object-cover" onError={() => setImgFailed(true)} />
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
      <span className="text-xs text-muted-foreground truncate max-w-[100px]">
        {name}
      </span>
      {isOpen && (
        <span className="size-1.5 rounded-full bg-primary" />
      )}
    </button>
  );

  const hasContextMenu = onTogglePin || onRegenerateIcon || onRename || onDelete;
  if (!hasContextMenu) return tile;

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
        {(onRename || onDelete) && (onTogglePin || onRegenerateIcon) && (
          <ContextMenuSeparator />
        )}
        {onRename && (
          <ContextMenuItem
            onSelect={() => {
              const newName = window.prompt("Rename app:", name);
              if (newName && newName.trim() && newName.trim() !== name) {
                onRename(newName.trim());
              }
            }}
          >
            <PencilIcon className="size-3.5 mr-2" />
            Rename
          </ContextMenuItem>
        )}
        {onDelete && (
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => {
              if (window.confirm(`Delete "${name}"? This cannot be undone.`)) {
                onDelete();
              }
            }}
          >
            <TrashIcon className="size-3.5 mr-2" />
            Delete
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
