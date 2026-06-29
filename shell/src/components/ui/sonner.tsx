"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon } from "lucide-react";

/**
 * Brand-themed sonner Toaster.
 *
 * - No theme provider in this shell, so colors are driven directly off the
 *   Matrix CSS-var tokens (popover / foreground / border) rather than a
 *   light/dark switch.
 * - Anchored above the bottom safe-area inset *and* the 64px mobile dock, and
 *   it rises with the on-screen keyboard via --terminal-keyboard-height so a
 *   toast is never hidden behind chrome or the keyboard.
 */
function Toaster({ ...props }: ToasterProps) {
  const bottomOffset =
    "calc(env(safe-area-inset-bottom, 0px) + 5rem + var(--terminal-keyboard-height, 0px))";

  return (
    <Sonner
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <div className="size-4 animate-pulse rounded-full bg-current/20" />,
      }}
      offset={{
        bottom: bottomOffset,
        top: "calc(env(safe-area-inset-top, 0px) + 1rem)",
      }}
      mobileOffset={{
        bottom: bottomOffset,
        top: "calc(env(safe-area-inset-top, 0px) + 0.75rem)",
      }}
      style={
        {
          "--normal-bg": "var(--surface-glass-strong)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--surface-glass-border)",
          "--border-radius": "var(--radius-lg)",
          "--width": "min(20rem, calc(100vw - 2rem))",
          "--toast-icon-margin-end": "8px",
          fontFamily: "var(--font-sans)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            "surface-glass-strong elevation-3 !gap-2 !rounded-xl !border !px-3.5 !py-2.5 !text-[13px] !leading-snug !text-popover-foreground font-sans",
          title: "!font-medium",
          description: "!text-muted-foreground",
          icon: "!mx-0 !size-4 [&>svg]:!size-4",
          success: "!text-[var(--success)]",
          error: "!text-destructive",
          warning: "!text-[var(--warning)]",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
