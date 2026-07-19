import { useIconWithFallback } from "@/hooks/useIconWithFallback";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { PencilIcon, PinOffIcon, RefreshCwIcon, XCircleIcon } from "lucide-react";

export function DockIcon({
  name,
  active,
  onClick,
  iconSize = 40,
  tooltipSide = "right",
  iconUrl,
  onUnpin,
  onRegenerateIcon,
  onRename,
  onQuit,
  canQuit,
}: {
  name: string;
  active: boolean;
  onClick: () => void;
  iconSize?: number;
  tooltipSide?: "left" | "right" | "top" | "bottom";
  iconUrl?: string;
  onUnpin?: () => void;
  onRegenerateIcon?: () => void;
  onRename?: (newName: string) => void;
  onQuit?: () => void;
  canQuit?: boolean;
}) {
  const initial = name.charAt(0).toUpperCase();
  const { showImage, onError: onImgError } = useIconWithFallback(iconUrl);

  const btn = (
    <button
      type="button"
      onClick={onClick}
      className="relative flex items-center justify-center rounded-xl shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all bg-card border border-border/60 overflow-hidden"
      style={{ width: iconSize, height: iconSize }}
    >
      {showImage ? (
        // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- app icon served from a runtime gateway host with an onError fallback chain (.png -> .svg) that next/image cannot reproduce
        <img src={iconUrl} alt={name} className="size-full object-cover" onError={onImgError} />
      ) : (
        <span className="text-sm font-semibold text-foreground">
          {initial}
        </span>
      )}
      {active && (
        <span className="absolute -right-1 top-1/2 -translate-y-1/2 size-1.5 rounded-full bg-foreground" />
      )}
    </button>
  );

  const hasContextMenu = onUnpin || onRegenerateIcon || onRename || onQuit;
  if (!hasContextMenu) {
    return (
      <Tooltip>
        <TooltipTrigger render={btn} />
        <TooltipContent side={tooltipSide} sideOffset={8}>{name}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>
        <Tooltip>
          <TooltipTrigger render={btn} />
          <TooltipContent side={tooltipSide} sideOffset={8}>{name}</TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-[60]">
        {onUnpin && (
          <ContextMenuItem onClick={onUnpin}>
            <PinOffIcon className="size-3.5 mr-2" />
            Unpin from Dock
          </ContextMenuItem>
        )}
        {onRegenerateIcon && (
          <ContextMenuItem onClick={onRegenerateIcon}>
            <RefreshCwIcon className="size-3.5 mr-2" />
            Regenerate Icon
          </ContextMenuItem>
        )}
        {onRename && (onUnpin || onRegenerateIcon) && (
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
        {onQuit && (
          <>
            {(onUnpin || onRegenerateIcon || onRename) && <ContextMenuSeparator />}
            <ContextMenuItem
              disabled={!canQuit}
              onClick={() => {
                if (canQuit) onQuit();
              }}
            >
              <XCircleIcon className="size-3.5 mr-2" />
              Quit
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
