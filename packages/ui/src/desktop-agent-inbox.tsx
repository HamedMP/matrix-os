"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { RuntimeSummarySchema, type RuntimeSummary } from "@matrix-os/contracts";
import * as Popover from "@radix-ui/react-popover";
import { Bell, Download } from "lucide-react";
import {
  AGENT_INBOX_GROUPS, deriveAgentInbox, formatInboxTime,
  type AgentInboxAvatar, type AgentInboxGroup, type AgentInboxItem, type AgentInboxPill,
} from "./agent-inbox-model.js";
import type { TerminalTabFacts } from "./terminal-agents/attention.js";
import { AgentLogo } from "./agent-logo.js";
import { isAgentLogoKind } from "./agent-logo-kind.js";
import { AGENT_INBOX_PILL_STYLE } from "./agent-inbox-pill-style.js";

const colors: CSSProperties = {
  color: "var(--text-primary, var(--foreground))",
  background: "var(--bg-surface, var(--card))",
  borderColor: "var(--border-subtle, var(--border))",
};
const muted: CSSProperties = { color: "var(--text-tertiary, var(--muted-foreground))" };
const actionClass = "no-drag relative flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current";
const rowClass = "grid w-full grid-cols-[30px_minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg p-2 text-left outline-none";
const MAX_BADGE = 9;

type MenuOverlay = { acquire(): void; release(): void };
function useMenuOverlay(open: boolean, overlay?: MenuOverlay) {
  useEffect(() => {
    if (!open || !overlay) return;
    overlay.acquire();
    return overlay.release;
  }, [open, overlay]);
}

type Filter = AgentInboxGroup | "all";
const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "all", label: "All" }, { id: "needs", label: "Needs you" }, { id: "running", label: "Running" }, { id: "done", label: "Done" },
];
const GROUP_LABEL: Record<AgentInboxGroup, string> = { needs: "Needs you", running: "Running", done: "Done" };
const EMPTY_COPY: Record<Filter, string> = {
  all: "No agent activity yet.", needs: "Nothing needs you right now.", running: "No agents are running.", done: "No finished agents yet.",
};
const STATUS_COLOR: Record<AgentInboxGroup, string> = { needs: "#E0A12E", running: "#3BA55D", done: "var(--text-tertiary, #8a8780)" };
const AVATAR: Record<AgentInboxAvatar, { letter: string; background: string; color?: string }> = {
  claude: { letter: "C", background: "#D97757" }, codex: { letter: "X", background: "#1D1C1B" },
  hermes: { letter: "H", background: "#5C6BC0" }, pi: { letter: "π", background: "#3F7F6E" },
  opencode: { letter: "O", background: "#4A5568" }, cursor: { letter: "Cu", background: "#2B2B2B" },
  agent: { letter: ">_", background: "var(--bg-sunken, var(--muted))", color: "var(--text-secondary, var(--foreground))" },
  app: { letter: "", background: "var(--bg-sunken, var(--muted))", color: "var(--text-secondary, var(--foreground))" },
};

export function DesktopInboxMenu({ children, count = 0, open, onOpenChange }: { children: ReactNode; count?: number; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const label = count > 0 ? `Inbox, ${count} agent${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} you` : "Inbox";
  return <Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button type="button" aria-label={label} className={actionClass}>
    <Bell size={14} aria-hidden="true" />
    {count > 0 ? <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none"
      style={{ background: "var(--accent, var(--primary))", color: "var(--bg-surface, var(--primary-foreground, #fff))" }}>{count > MAX_BADGE ? `${MAX_BADGE}+` : count}</span> : null}
  </button></Popover.Trigger><Popover.Portal><Popover.Content aria-label="Agents" side="bottom" align="end" sideOffset={6} collisionPadding={8}
    className="no-drag w-[400px] max-w-[calc(100vw-16px)] overflow-hidden rounded-2xl border shadow-lg outline-none" style={{ ...colors, zIndex: "var(--desktop-menu-z, 11000)" }}>
    {children}
  </Popover.Content></Popover.Portal></Popover.Root>;
}

/**
 * Herdr-style agent inbox shared by Web Desktop and Electron Desktop: coding-agent
 * threads from the bounded runtime summary plus live terminal agents. Each renderer
 * supplies the open actions for its own Chat and Terminal surfaces.
 */
export function DesktopActivityInbox({ scope, load, terminalTabs, onOpenTask, onOpenTerminal, overlay, now }: {
  scope: string; load(): Promise<unknown>;
  /** Live per-tab agent status from `/ws/terminal/events`, keyed by `workspaceId:tabId`. */
  terminalTabs?: Readonly<Record<string, TerminalTabFacts>>;
  /** Opens a coding-agent thread's own chat. */
  onOpenTask?: (id: string) => void;
  /** Focuses one exact terminal tab (`workspaceId:tabId`) in the durable Terminal. */
  onOpenTerminal?: (key: string) => void;
  overlay?: MenuOverlay; now?: () => number;
}) {
  // Remount on an owner/computer change so even an already-open popup cannot flash old data.
  return <ScopedActivityInbox key={scope} load={load} terminalTabs={terminalTabs} onOpenTask={onOpenTask} onOpenTerminal={onOpenTerminal} overlay={overlay} now={now} />;
}

function ScopedActivityInbox({ load, terminalTabs, onOpenTask, onOpenTerminal, overlay, now }: {
  load(): Promise<unknown>; terminalTabs?: Readonly<Record<string, TerminalTabFacts>>;
  onOpenTask?: (id: string) => void; onOpenTerminal?: (key: string) => void; overlay?: MenuOverlay; now?: () => number;
}) {
  const [open, setOpen] = useState(false);
  useMenuOverlay(open, overlay);
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [snapshot, setSnapshot] = useState<RuntimeSummary | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  // Reference time for relative labels, taken when each summary arrives.
  const [nowMs, setNowMs] = useState(0);
  const readClock = useEffectEvent(() => (now ?? Date.now)());
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = RuntimeSummarySchema.parse(await load());
        if (active) { setSnapshot(result); setNowMs(readClock()); setStatus("ready"); }
      } catch (error: unknown) {
        // Never log raw names/messages or schema issues containing owner data.
        const category = error instanceof Error
          ? (["AbortError", "TimeoutError", "ZodError"].includes(error.name) ? error.name : "Error")
          : "non-error";
        console.warn("[desktop-inbox] load failed:", category);
        if (active) { setSnapshot(null); setStatus("error"); }
      } finally { inFlight = false; }
    };
    // A shown snapshot stays while it refreshes; only an unknown state reads as loading.
    setStatus((current) => (current === "ready" ? current : "loading"));
    void refresh();
    const timer = setInterval(() => { if (open) void refresh(); }, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [load, open, retry]);

  const model = useMemo(() => deriveAgentInbox({ summary: snapshot, terminalTabs }), [snapshot, terminalTabs]);
  const visible = filter === "all" ? model.items : model.items.filter((item) => item.group === filter);
  const groups = AGENT_INBOX_GROUPS.filter((group) => visible.some((item) => item.group === group));

  const openItem = (item: AgentInboxItem): (() => void) | undefined => {
    const target = item.target;
    if (!target) return undefined;
    if (target.kind === "thread" && onOpenTask) return () => onOpenTask(target.threadId);
    const terminalKey = target.kind === "terminal" ? target.key : target.terminalKey;
    if (terminalKey && onOpenTerminal) return () => onOpenTerminal(terminalKey);
    return undefined;
  };

  return <DesktopInboxMenu open={open} onOpenChange={setOpen} count={model.counts.needs}>
    <div className="flex items-center px-3.5 pb-2 pt-3"><h2 className="text-sm font-semibold">Agents</h2></div>
    {status === "loading" ? <p role="status" className="px-3.5 pb-3 text-xs">Loading agents…</p> : null}
    {status === "error" ? <div className="px-3.5 pb-3"><p role="alert" className="text-xs">Notifications are unavailable.</p>
      <button type="button" className="mt-1 rounded-md px-2 py-1 text-xs hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current" aria-label="Retry notifications" onClick={() => setRetry(value => value + 1)}>Retry</button></div> : null}
    {status === "ready" ? <>
      <div className="flex gap-1 border-b px-3 pb-2.5" style={{ borderColor: colors.borderColor }}>
        {FILTERS.map(({ id, label }) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current aria-pressed:bg-black/5 aria-pressed:font-medium">
          {label} <span className="text-[11px]" style={muted}>{model.counts[id]}</span>
        </button>)}
      </div>
      <div className="max-h-[min(470px,70vh)] overflow-y-auto p-1.5">
        {visible.length === 0 ? <p className="px-2 py-6 text-center text-xs" style={muted}>{EMPTY_COPY[filter]}</p> : null}
        {groups.map(group => <section key={group} aria-label={GROUP_LABEL[group]}>
          <h3 className="flex items-center gap-2 px-2.5 pb-1.5 pt-2.5 text-[11px] font-semibold uppercase tracking-wide" style={muted}>
            <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: STATUS_COLOR[group] }} />{GROUP_LABEL[group]}
          </h3>
          {visible.filter(item => item.group === group).map(item => {
            const action = openItem(item);
            return <AgentInboxRow key={item.key} item={item} time={formatInboxTime(item.at, nowMs)}
              onOpen={action ? () => { setOpen(false); action(); } : undefined} />;
          })}
        </section>)}
      </div>
      {model.truncated ? <p className="border-t px-3.5 py-2 text-[11.5px]" style={{ ...muted, borderColor: colors.borderColor }}>Showing the most recent agents.</p> : null}
    </> : null}
  </DesktopInboxMenu>;
}

function AgentInboxRow({ item, time, onOpen }: { item: AgentInboxItem; time: string; onOpen?: () => void }) {
  const avatar = AVATAR[item.avatar];
  const body = <>
    {item.avatar === "app"
      ? <span aria-hidden="true" className="grid size-[30px] place-items-center rounded-lg" style={{ background: avatar.background, color: avatar.color }}><Download size={13} /></span>
      : <AgentLogo kind={isAgentLogoKind(item.avatar) ? item.avatar : undefined} label={avatar.letter || item.title} dimmed={item.group === "done"}
        badge={item.group !== "done" ? <span className="absolute -bottom-[3px] -right-[3px] size-[11px] rounded-full border-2"
          style={{ background: item.pill === "Approval" || item.pill === "Failed" ? "#D64541" : STATUS_COLOR[item.group], borderColor: "var(--bg-surface, var(--card))" }} /> : null} />}
    <span className="min-w-0">
      <span className="block truncate text-[13.5px] font-medium leading-snug">{item.title}</span>
      {item.subline.length > 0 ? <span className="mt-0.5 block truncate text-xs" style={muted}>{item.subline.join(" · ")}</span> : null}
      {item.message ? <span className="mt-1.5 block rounded-lg border px-2 py-1.5 text-[12.5px] leading-snug"
        style={{ borderColor: colors.borderColor, background: "var(--bg-sunken, var(--muted))" }}>{item.message}</span> : null}
    </span>
    <span className="flex flex-col items-end gap-1.5">
      {time ? <span className="whitespace-nowrap text-[11.5px]" style={muted}>{time}</span> : null}
      <span className="whitespace-nowrap rounded-full px-1.5 py-px text-[11px] font-semibold" style={AGENT_INBOX_PILL_STYLE[item.pill]}>{item.pill}</span>
    </span>
  </>;
  return onOpen
    ? <button type="button" className={`${rowClass} hover:bg-black/5 focus-visible:bg-black/5 focus-visible:ring-2 focus-visible:ring-current`} onClick={onOpen}>{body}</button>
    : <div className={rowClass}>{body}</div>;
}
