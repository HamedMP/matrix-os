"use client";
import { PinIcon, RefreshCwIcon, PencilIcon, EyeOffIcon } from "lucide-react";
import { useIconWithFallback } from "@/hooks/useIconWithFallback";
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
  onRemoveFromCanvas?: () => void;
}

export function AppTile({ name, isOpen, onClick, pinned, onTogglePin, iconUrl, onRegenerateIcon, onRename, onRemoveFromCanvas }: AppTileProps) {
  const initial = name.charAt(0).toUpperCase();
  const { showImage, onError: onImgError } = useIconWithFallback(iconUrl);

  const tile = (
    <button
      type="button"
      onClick={onClick}
      data-app-tile
      className="relative flex flex-col items-center gap-1.5 p-1.5 rounded-xl hover:bg-accent/50 transition-colors group"
    >
      <div className="relative">
        <div
          data-app-icon
          className={`flex size-24 items-center justify-center rounded-[22px] shadow-sm text-2xl font-semibold transition-all overflow-hidden ${
            isOpen
              ? "bg-primary/10 border border-primary/40 text-primary shadow-primary/20 shadow-md"
              : "bg-card border border-border/60 text-foreground group-hover:shadow-md"
          }`}
        >
          {showImage ? (
            // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- app icon served from a runtime gateway host (/icons/{slug}.png) that cannot be statically configured for next/image
            <img src={iconUrl} alt={name} className="size-full object-cover" onError={onImgError} />
          ) : (
            initial
          )}
        </div>
        {onTogglePin && (
          <span
            // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- cannot be a native <button>: this pin toggle is nested inside the outer tile <button>, and nesting interactive elements is invalid HTML
            role="button"
            tabIndex={0}
            aria-label={pinned ? "Unpin from dock" : "Pin to dock"}
            aria-pressed={pinned}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onTogglePin();
              }
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
      <span className="text-xs text-white truncate max-w-[100px]">
        {name}
      </span>
      {isOpen && (
        <span className="size-1.5 rounded-full bg-primary" />
      )}
    </button>
  );

  const hasContextMenu = onTogglePin || onRegenerateIcon || onRename || onRemoveFromCanvas;
  if (!hasContextMenu) return tile;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={tile} />
      <ContextMenuContent>
        {onTogglePin && (
          <ContextMenuItem onClick={onTogglePin}>
            <PinIcon className="size-3.5 mr-2" />
            {pinned ? "Unpin from Dock" : "Pin to Dock"}
          </ContextMenuItem>
        )}
        {onRegenerateIcon && (
          <ContextMenuItem onClick={onRegenerateIcon}>
            <RefreshCwIcon className="size-3.5 mr-2" />
            Regenerate Icon
          </ContextMenuItem>
        )}
        {(onRename || onRemoveFromCanvas) && (onTogglePin || onRegenerateIcon) && (
          <ContextMenuSeparator />
        )}
        {onRename && (
          <ContextMenuItem
            onClick={() => {
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
        {onRemoveFromCanvas && (
          <ContextMenuItem onClick={onRemoveFromCanvas}>
            <EyeOffIcon className="size-3.5 mr-2" />
            Remove from canvas
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
