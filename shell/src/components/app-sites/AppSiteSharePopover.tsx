"use client";

import type { ReactNode } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";

export function AppSiteSharePopover({
  children,
  onOpenChange,
  open,
  portalContainer,
  trigger,
  zIndex,
}: {
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  portalContainer?: HTMLElement | null;
  trigger: ReactNode;
  zIndex: number;
}) {
  return (
    <PopoverPrimitive.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
        <PopoverPrimitive.Content
          role="dialog"
          aria-label="Share app"
          side="bottom"
          align="end"
          sideOffset={6}
          collisionBoundary={portalContainer ?? undefined}
          collisionPadding={8}
          style={{
            width: "min(24rem, var(--radix-popover-content-available-width))",
            maxHeight: "min(34rem, var(--radix-popover-content-available-height))",
            zIndex,
            background: "var(--background, var(--bg-overlay, Canvas))",
            color: "var(--foreground, var(--text-primary, CanvasText))",
            borderColor: "var(--border, var(--border-default, color-mix(in srgb, CanvasText 18%, transparent)))",
            boxShadow: "var(--shadow-3, 0 16px 40px rgb(0 0 0 / 0.2))",
          }}
          className="overflow-hidden rounded-lg border outline-none"
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
