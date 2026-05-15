"use client";

import type { ReactNode } from "react";
import { HomeIcon } from "lucide-react";

interface MobileAppSurfaceProps {
  title: string;
  onHome: () => void;
  children?: ReactNode;
  unavailableMessage?: string;
}

export function MobileAppSurface({ title, onHome, children, unavailableMessage }: MobileAppSurfaceProps) {
  return (
    <section data-testid="mobile-app-surface" className="absolute inset-0 flex flex-col overflow-hidden bg-background text-foreground">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/50 px-3 pt-[env(safe-area-inset-top)]">
        <button
          type="button"
          data-testid="mobile-home-button"
          onClick={onHome}
          className="inline-flex size-10 items-center justify-center rounded-lg border border-border/60 bg-card text-foreground transition active:scale-95"
          aria-label="Home"
        >
          <HomeIcon className="size-4" />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
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
