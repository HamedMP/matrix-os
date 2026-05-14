"use client";

import type { AppEntry } from "@/hooks/useWindowManager";
import { BrushIcon, ExternalLinkIcon, HomeIcon } from "lucide-react";

interface MobileLauncherProps {
  apps: AppEntry[];
  openWindowPaths: Set<string>;
  onOpenApp: (name: string, path: string) => void;
  resumeApp?: AppEntry | null;
  onResumeApp?: (name: string, path: string) => void;
  onOpenCanvas?: () => void;
}

export function MobileLauncher({
  apps,
  openWindowPaths,
  onOpenApp,
  resumeApp,
  onResumeApp,
  onOpenCanvas,
}: MobileLauncherProps) {
  return (
    <section data-testid="mobile-launcher" className="absolute inset-0 flex flex-col bg-background text-foreground">
      <header className="shrink-0 border-b border-border/50 px-5 pb-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl border border-border/60 bg-card">
            <HomeIcon className="size-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">Matrix</h1>
            <p className="truncate text-xs text-muted-foreground">Apps</p>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-3 grid gap-3">
          {resumeApp ? (
            <button
              type="button"
              data-testid="mobile-resume-app"
              onClick={() => (onResumeApp ?? onOpenApp)(resumeApp.name, resumeApp.path)}
              className="flex min-h-[72px] items-center gap-3 rounded-lg border border-primary/50 bg-card p-3 text-left shadow-sm transition active:scale-[0.98]"
            >
              <div className="flex size-11 items-center justify-center rounded-xl bg-primary/15 text-sm font-semibold text-primary">
                {resumeApp.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-primary">Continue</div>
                <div className="truncate text-sm font-medium">{resumeApp.name}</div>
              </div>
              <ExternalLinkIcon className="size-4 text-primary" aria-hidden />
            </button>
          ) : null}
          {onOpenCanvas ? (
            <button
              type="button"
              data-testid="mobile-open-canvas"
              onClick={onOpenCanvas}
              className="flex min-h-[64px] items-center gap-3 rounded-lg border border-border/60 bg-card p-3 text-left shadow-sm transition active:scale-[0.98]"
            >
              <div className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                <BrushIcon className="size-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">Canvas</div>
                <div className="truncate text-xs text-muted-foreground">Open spatial workspace</div>
              </div>
            </button>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {apps.map((app) => {
            const open = openWindowPaths.has(app.path);
            return (
              <button
                key={app.path}
                type="button"
                data-testid={`mobile-launcher-app-${app.path}`}
                onClick={() => onOpenApp(app.name, app.path)}
                className="min-h-[118px] rounded-lg border border-border/60 bg-card p-3 text-left shadow-sm transition active:scale-[0.98]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex size-12 items-center justify-center rounded-xl bg-secondary text-sm font-semibold text-secondary-foreground">
                    {app.name.charAt(0).toUpperCase()}
                  </div>
                  {open ? (
                    <span className="inline-flex size-2.5 rounded-full bg-primary" aria-label="Open" />
                  ) : (
                    <ExternalLinkIcon className="size-4 text-muted-foreground" aria-hidden />
                  )}
                </div>
                <div className="mt-3 min-w-0">
                  <div className="truncate text-sm font-medium">{app.name}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {open ? "Open" : app.path.replace(/^apps\//, "").replace(/\/index\.html$/, "")}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
