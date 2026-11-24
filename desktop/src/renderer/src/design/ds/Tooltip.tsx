import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

// Design-library Tooltip: foreground fill, 12px medium text, 8px radius.
// z-[100] matches DESKTOP_Z_INDEX.popover so tooltips sit above dialogs.
export const tooltipContentClass =
  "z-[100] max-w-72 rounded-md bg-ds-foreground px-2 py-1 font-ds-sans text-ds-ui-xs font-medium text-ds-background shadow-ds-lg";

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactElement; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content side={side} sideOffset={6} className={tooltipContentClass}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
