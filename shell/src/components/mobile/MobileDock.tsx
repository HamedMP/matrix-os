"use client";

import type { ReactNode } from "react";
import { Layers, LayoutGrid } from "@/lib/hugeicons";
import { MobileAppIcon } from "./MobileAppIcon";
import type { MobileApp } from "./mobile-app";

export function MobileDock({
  apps, currentPath, view, hidden, openCount, onOpen, onShowApps, onShowSwitcher,
}: {
  apps: MobileApp[];
  currentPath?: string;
  view: "launcher" | "app" | "switcher";
  hidden: boolean;
  openCount: number;
  onOpen: (app: MobileApp) => void;
  onShowApps: () => void;
  onShowSwitcher: () => void;
}) {
  return (
    <nav
      aria-label="App navigation"
      data-testid="mobile-bottom-dock"
      className="shrink-0 items-center justify-around gap-1 px-2 py-2"
      style={{
        display: hidden ? "none" : "flex",
        minHeight: 72,
        color: "var(--foreground)",
        background: "color-mix(in srgb, var(--background) 94%, transparent)",
        borderTop: "1px solid color-mix(in srgb, var(--foreground) 14%, transparent)",
      }}
    >
      {apps.map((app) => (
        <DockButton key={app.id} label={app.name} current={currentPath === app.path} onClick={() => onOpen(app)}>
          <MobileAppIcon slug={app.iconSlug} size={28} />
        </DockButton>
      ))}
      <DockButton label="Apps" current={view === "launcher"} onClick={onShowApps}>
        <LayoutGrid size={26} aria-hidden />
      </DockButton>
      <DockButton label="Open" current={view === "switcher"} onClick={onShowSwitcher} disabled={openCount === 0} badge={openCount}>
        <Layers size={26} aria-hidden />
      </DockButton>
    </nav>
  );
}

function DockButton({ label, current, onClick, disabled, badge = 0, children }: {
  label: string;
  current: boolean;
  onClick: () => void;
  disabled?: boolean;
  badge?: number;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-current={current ? "page" : undefined}
      className="relative flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:opacity-45"
      style={{
        color: "inherit",
        background: current ? "color-mix(in srgb, var(--foreground) 9%, transparent)" : "transparent",
        fontSize: 11,
        fontWeight: current ? 650 : 500,
      }}
    >
      {children}
      <span>{label}</span>
      {badge > 0 ? (
        <span aria-hidden className="absolute top-0.5 right-1 rounded-full px-1.5 text-[10px] font-semibold" style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}>
          {badge}
        </span>
      ) : null}
    </button>
  );
}
