"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, CircleCheck, LayoutGrid, MessageCircle, Monitor, Search, SquareTerminal } from "lucide-react";

const colors: CSSProperties = {
  color: "var(--text-primary, var(--foreground))",
  background: "var(--bg-surface, var(--card))",
  borderColor: "var(--border-subtle, var(--border))",
};
const actionClass = "no-drag relative flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current";
const rowClass = "flex w-full cursor-default items-center gap-2.5 rounded-md p-2 text-left text-[13px] outline-none hover:bg-black/5 focus-visible:bg-black/5 data-[highlighted]:bg-black/5";

type MenuOverlay = { acquire(): void; release(): void };
function useMenuOverlay(open: boolean, overlay?: MenuOverlay) {
  useEffect(() => {
    if (!open || !overlay) return;
    overlay.acquire();
    return overlay.release;
  }, [open, overlay]);
}

/** Shared structure and ordering; each renderer supplies authenticated actions. */
export function DesktopTopBarActions({ onSearch, onSupport, onTerminal, setup, inbox, computer, update, account }: {
  onSearch(): void; onSupport(): void;
  /** Opens the native Terminal window. Only Electron Desktop has one, so other renderers omit it. */
  onTerminal?(): void;
  /** Getting started pill; the renderer renders nothing once setup is complete. */
  setup?: ReactNode; inbox: ReactNode; computer: ReactNode; update?: ReactNode; account: ReactNode;
}) {
  return <nav aria-label="Desktop controls" className="no-drag flex h-full shrink-0 items-center gap-2" style={{ color: colors.color }}>
    {setup}
    <button type="button" aria-label="Search" title="Search (Cmd+K)" className={actionClass} onClick={onSearch}><Search size={14} aria-hidden="true" /></button>
    {onTerminal ? <button type="button" aria-label="Terminal window" title="Open Terminal window" className={actionClass} onClick={onTerminal}><SquareTerminal size={14} aria-hidden="true" /></button> : null}
    {inbox}<button type="button" aria-label="Support" title="Support chat" className={actionClass} onClick={onSupport}><MessageCircle size={14} aria-hidden="true" /></button><div className="min-w-0 w-[156px] max-[600px]:w-28">{computer}</div>{update}{account}
  </nav>;
}

export function DesktopViewMenu({ mode, onModeChange, onShowDesktop, selected, tab = false, overlay }: {
  mode: "desktop" | "canvas"; onModeChange(mode: "desktop" | "canvas"): void; onShowDesktop(): void; selected?: boolean; tab?: boolean; overlay?: MenuOverlay;
}) {
  const [open, setOpen] = useState(false);
  useMenuOverlay(open, overlay);
  const Icon = mode === "canvas" ? LayoutGrid : Monitor;
  return <DropdownMenu.Root open={open} onOpenChange={setOpen}>
    <DropdownMenu.Trigger asChild><button type="button" role={tab ? "tab" : undefined} aria-label={tab ? "Desktop" : "Workspace view"}
      aria-selected={tab ? selected : undefined} title="Desktop and Canvas views"
      className="no-drag flex h-[38px] w-14 shrink-0 items-center justify-center gap-1 border-r outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-current"
      style={{ borderColor: colors.borderColor, color: colors.color }}><Icon size={14} aria-hidden="true" /><ChevronDown size={12} aria-hidden="true" /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content aria-label="Workspace view" side="bottom" align="start" sideOffset={6}
      className="no-drag w-[200px] rounded-xl border p-1.5 shadow-lg" style={{ ...colors, zIndex: "var(--desktop-menu-z, 11000)" }}>
      <DropdownMenu.Item className={rowClass} onSelect={onShowDesktop}><Monitor size={14} aria-hidden="true" />Show desktop</DropdownMenu.Item>
      <DropdownMenu.Separator className="my-0.5 h-px" style={{ background: colors.borderColor }} />
      <DropdownMenu.RadioGroup value={mode}>
        {(["desktop", "canvas"] as const).map(value => {
          const ModeIcon = value === "desktop" ? Monitor : LayoutGrid;
          return <DropdownMenu.RadioItem key={value} value={value} className={rowClass} onSelect={() => onModeChange(value)}>
            <ModeIcon size={14} aria-hidden="true" /><span className="flex-1">{value === "desktop" ? "Desktop view" : "Canvas view"}</span>
            <DropdownMenu.ItemIndicator><CircleCheck size={14} aria-hidden="true" /></DropdownMenu.ItemIndicator>
          </DropdownMenu.RadioItem>;
        })}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
