import { useVocalStore } from "@/stores/vocal";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MicIcon } from "lucide-react";

/**
 * Aoede's dock entrypoint. Uses the `.aoede-dock-button` class for the
 * shimmer ring + fill sweep shared with the "Enter Matrix OS" wordmark.
 */
export function AoedeDockButton({
  size,
  variant,
  tooltipSide,
}: {
  size: number;
  variant: "desktop" | "mobile";
  tooltipSide?: "left" | "right" | "top";
}) {
  const active = useVocalStore((s) => s.active);
  const toggle = useVocalStore((s) => s.toggle);

  const button = (
    <button
      type="button"
      data-testid={variant === "desktop" ? "dock-vocal" : "dock-vocal-mobile"}
      data-active={active ? "true" : "false"}
      onClick={toggle}
      className="aoede-dock-button flex shrink-0 items-center justify-center rounded-full bg-white text-black border border-border/60 shadow-sm transition-transform hover:scale-105 active:scale-95"
      style={{ width: size, height: size }}
      aria-label={active ? "Stop Aoede" : "Start Aoede"}
      aria-pressed={active}
    >
      <MicIcon className="size-4" />
    </button>
  );

  if (variant === "mobile") return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={tooltipSide} sideOffset={8}>
        {active ? "Aoede (on)" : "Aoede"}
      </TooltipContent>
    </Tooltip>
  );
}
