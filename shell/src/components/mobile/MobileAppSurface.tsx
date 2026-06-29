"use client";

import type { ReactNode } from "react";
import { HomeIcon } from "lucide-react";

interface MobileAppSurfaceProps {
  title: string;
  onHome: () => void;
  children?: ReactNode;
  /** Optional actions rendered on the trailing edge of the header. */
  trailing?: ReactNode;
  unavailableMessage?: string;
}

export function MobileAppSurface({
  title,
  onHome,
  children,
  trailing,
  unavailableMessage,
}: MobileAppSurfaceProps) {
  return (
    <section
      data-testid="mobile-app-surface"
      className="absolute inset-0 flex flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="surface-glass-strong sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b px-2 pt-[env(safe-area-inset-top)]">
        <div className="flex min-h-11 w-full items-center gap-2">
          <button
            type="button"
            data-testid="mobile-home-button"
            onClick={onHome}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-card/70 text-foreground transition-transform duration-150 ease-[var(--ease-emphasized)] active:scale-90"
            aria-label="Home"
          >
            <HomeIcon className="size-5" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-center text-[0.95rem] font-medium tracking-tight">
            {title}
          </h1>
          <div className="flex min-h-11 min-w-11 shrink-0 items-center justify-end gap-1">
            {trailing}
          </div>
        </div>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {children ?? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="text-sm font-semibold">App unavailable</div>
            <div className="mt-2 max-w-[28ch] text-xs leading-5 text-muted-foreground">
              {unavailableMessage ?? "Return home and open the app again."}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
