"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { RuntimeSummarySchema, type RuntimeSummary } from "@matrix-os/contracts";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { Bell, ChevronDown, CircleCheck, CircleHelp, ExternalLink, LayoutGrid, MessageCircle, Monitor, Search } from "lucide-react";

const useHelpPopoverScope = Popover.createPopoverScope();

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
export function DesktopTopBarActions({ onSearch, inbox, help, computer, update, account }: {
  onSearch(): void; inbox: ReactNode; help: ReactNode; computer: ReactNode; update?: ReactNode; account: ReactNode;
}) {
  return <nav aria-label="Desktop controls" className="no-drag flex h-full shrink-0 items-center gap-2" style={{ color: colors.color }}>
    <button type="button" aria-label="Search" title="Search (Cmd+K)" className={actionClass} onClick={onSearch}><Search size={14} aria-hidden="true" /></button>
    {inbox}{help}<div className="min-w-0 w-[156px] max-[600px]:w-28">{computer}</div>{update}{account}
  </nav>;
}

export function DesktopHelpMenu({ gettingStarted, incomplete, onSupport, discordIcon, overlay }: {
  gettingStarted: ReactNode; incomplete: boolean; onSupport(): void; discordIcon: ReactNode; overlay?: MenuOverlay;
}) {
  const helpScope = useHelpPopoverScope(undefined);
  const [open, setOpen] = useState(false);
  useMenuOverlay(open, overlay);
  return <Popover.Root {...helpScope} open={open} onOpenChange={setOpen}>
    <Popover.Trigger {...helpScope} asChild><button type="button" aria-label="Help" className={actionClass}>
      <CircleHelp size={14} aria-hidden="true" />
      {incomplete ? <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full" style={{ background: "var(--accent, var(--primary))" }} /> : null}
    </button></Popover.Trigger>
    <Popover.Portal {...helpScope} forceMount><Popover.Content {...helpScope} hidden={!open} aria-label="Help" side="bottom" align="end" sideOffset={6} collisionPadding={8}
      forceMount className="data-[state=closed]:hidden no-drag w-[240px] rounded-xl border p-1.5 shadow-lg outline-none" style={{ ...colors, zIndex: "var(--desktop-menu-z, 11000)" }}>
      {gettingStarted}
      <div className="my-0.5 h-px" style={{ background: colors.borderColor }} />
      <button type="button" className={rowClass} onClick={() => { setOpen(false); onSupport(); }}><MessageCircle size={14} aria-hidden="true" />Support chat</button>
      <a href="https://discord.gg/WHbvTG33w" target="_blank" rel="noopener noreferrer" className={rowClass} onClick={() => setOpen(false)}>
        {discordIcon}<span className="flex-1">Join Discord</span><ExternalLink size={12} aria-hidden="true" />
      </a>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
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

export function DesktopInboxMenu({ children, count = 0, open, onOpenChange }: { children: ReactNode; count?: number; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  return <Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button type="button" aria-label="Inbox" className={actionClass}>
    <Bell size={14} aria-hidden="true" />{count > 0 ? <span aria-label={`${count} tasks need attention`} className="absolute right-0 top-0 size-1.5 rounded-full" style={{ background: "var(--accent, var(--primary))" }} /> : null}
  </button></Popover.Trigger><Popover.Portal><Popover.Content aria-label="Inbox" side="bottom" align="end" sideOffset={6} collisionPadding={8}
    className="no-drag w-[320px] max-w-[calc(100vw-16px)] rounded-xl border p-3 shadow-lg outline-none" style={{ ...colors, zIndex: "var(--desktop-menu-z, 11000)" }}>
    <h2 className="mb-2 text-sm font-medium">Inbox</h2>{children}
  </Popover.Content></Popover.Portal></Popover.Root>;
}


/** Bounded runtime activity shared by Web and Electron; no local notification database. */
export function DesktopActivityInbox({ scope, load, onOpenTask, overlay }: {
  scope: string; load(): Promise<unknown>; onOpenTask?: (id: string) => void; overlay?: MenuOverlay;
}) {
  // Remount on an owner/computer change so even an already-open popup cannot flash old data.
  return <ScopedActivityInbox key={scope} load={load} onOpenTask={onOpenTask} overlay={overlay} />;
}

function ScopedActivityInbox({ load, onOpenTask, overlay }: { load(): Promise<unknown>; onOpenTask?: (id: string) => void; overlay?: MenuOverlay }) {
  const [open, setOpen] = useState(false);
  useMenuOverlay(open, overlay);
  const [retry, setRetry] = useState(0);
  const [snapshot, setSnapshot] = useState<RuntimeSummary | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = RuntimeSummarySchema.parse(await load());
        if (active) { setSnapshot(result); setStatus("ready"); }
      } catch (error: unknown) {
        // Never log raw names/messages or schema issues containing owner data.
        const category = error instanceof Error
          ? (["AbortError", "TimeoutError", "ZodError"].includes(error.name) ? error.name : "Error")
          : "non-error";
        console.warn("[desktop-inbox] load failed:", category);
        if (active) { setSnapshot(null); setStatus("error"); }
      } finally { inFlight = false; }
    };
    setStatus("loading");
    void refresh();
    const timer = setInterval(() => { if (open) void refresh(); }, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [load, open, retry]);
  const attention = snapshot?.attentionThreads.items ?? [];
  const activity = (snapshot?.recentActivity.items ?? []).slice(0, 20);
  return <DesktopInboxMenu open={open} onOpenChange={setOpen} count={attention.length}>
    {status === "loading" ? <p role="status" className="text-xs">Loading notifications…</p> : null}
    {status === "error" ? <><p role="alert" className="text-xs">Notifications are unavailable.</p><button type="button" className={rowClass} aria-label="Retry notifications" onClick={() => setRetry(value => value + 1)}>Retry</button></> : null}
    {status === "ready" ? <div className="max-h-[min(420px,70vh)] overflow-y-auto">
      {attention.length === 0 && activity.length === 0 ? <p className="text-xs">No app or task notifications yet.</p> : null}
      {attention.map(thread => <div key={thread.id} className="border-b py-2" style={{ borderColor: colors.borderColor }}>
        {onOpenTask ? <button type="button" className={rowClass} onClick={() => { setOpen(false); onOpenTask(thread.id); }}>{thread.title}</button> : <p className="text-sm">{thread.title}</p>}
        <p className="text-xs opacity-70">{thread.attention === "approval_required" ? "Approval needed" : thread.attention === "input_required" ? "Input needed" : "Task needs attention"}</p>
      </div>)}
      {activity.map(event => <div key={event.id} className="py-2"><p className="text-sm">{event.label}</p><time dateTime={event.occurredAt} className="text-xs opacity-70">{new Date(event.occurredAt).toLocaleString()}</time></div>)}
      {snapshot?.recentActivity.hasMore || snapshot?.attentionThreads.hasMore ? <p className="text-xs opacity-70">Showing recent activity.</p> : null}
    </div> : null}
  </DesktopInboxMenu>;
}
