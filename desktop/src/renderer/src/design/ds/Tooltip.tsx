import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";
import { DESKTOP_Z_INDEX } from "../layering";

// Design-library Tooltip: foreground fill, 12px medium text, 8px radius.
export const tooltipContentClass =
  "max-w-72 rounded-md bg-ds-foreground px-2 py-1 font-ds-sans text-ds-ui-xs font-medium text-ds-background shadow-ds-lg";

/** Tooltips sit on the shared popover layer, above dialogs. */
export const tooltipLayerStyle = { zIndex: DESKTOP_Z_INDEX.popover };

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactElement; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content side={side} sideOffset={6} className={tooltipContentClass} style={tooltipLayerStyle}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
