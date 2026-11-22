// The Terminal window's top tab bar (spec 2706), like Herdr's workspaces:
// each tab shows its agent's icon and name, a spinner while it works, how
// many panes it holds, a close button, and + for a new terminal.
import type { ReactNode } from "react";
import { LayoutGrid, Loader2, Plus, X } from "lucide-react";
import { Button } from "../../design/primitives";
import { COMPACT_ICON_BUTTON, COMPACT_ICON_BUTTON_CLASS } from "./compact-icon-button";
import type { TerminalSidebarRow } from "@matrix-os/ui/terminal-status-sidebar";
import type { OpenTab } from "./use-open-tabs";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };

/** The active space, shown as a chip before its tabs; null is All. */
export interface ActiveSpaceChip {
  label: string;
  machine: string;
  color: string;
  icon?: string;
}

/** How the chip reads: All, a machine (a space itself), or a project on a machine. */
function chipText(space: ActiveSpaceChip | null) {
  if (!space) return { label: "All", aria: "All spaces", title: "All spaces (Ctrl+1…9 picks one)", badge: "∗" };
  const named = space.label === space.machine ? space.label : `${space.label} · ${space.machine}`;
  return {
    label: space.label,
    aria: space.label === space.machine ? `Space ${space.label}` : `Space ${space.label} on ${space.machine}`,
    title: `${named} (Ctrl+0 shows all)`,
    badge: space.icon ?? (space.label.trim()[0] ?? "?").toUpperCase(),
  };
}

function SpaceChip({ space }: { space: ActiveSpaceChip | null }) {
  const text = chipText(space);
  const frame = space
    ? { borderColor: space.color, background: `color-mix(in srgb, ${space.color} 14%, transparent)` }
    : { borderColor: "var(--border-default)" };
  const badge = space
    ? { background: space.icon ? "transparent" : space.color, ...(space.icon ? { fontSize: 12 } : {}) }
    : { background: "transparent", color: secondaryText.color };
  return (
    <span role="status" aria-label={text.aria} title={text.title}
      className="mb-1 flex h-6 max-w-[180px] shrink-0 items-center gap-1.5 rounded-full border pl-1 pr-2.5 text-[12px] font-medium" style={frame}>
      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[9px] font-bold text-white" style={badge}>
        {text.badge}
      </span>
      <span className="min-w-0 truncate">{text.label}</span>
    </span>
  );
}

export interface TerminalTabBarProps {
  /** The active space; its tabs are the ones listed. */
  space: ActiveSpaceChip | null;
  /** The overview of every terminal in the space, its own entry in the bar (Cmd+Shift+O). */
  overview: { open: boolean; onToggle(): void };
  tabs: readonly OpenTab[];
  /** The tab on screen: the one holding the selected terminal. */
  selectedKey: string | null;
  row(key: string): TerminalSidebarRow | undefined;
  icon(row: TerminalSidebarRow | undefined): ReactNode;
  onSelect(key: string): void;
  onClose(id: string): void;
  onNew(): void;
}

export function TerminalTabBar({ space, overview, tabs, selectedKey, row, icon, onSelect, onClose, onNew }: TerminalTabBarProps) {
  return (
    <div className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b px-1.5 pt-1.5"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
      <SpaceChip space={space} />
      <button type="button" aria-pressed={overview.open} aria-label="Overview" title="Overview of every terminal here (⌘⇧O)" onClick={overview.onToggle}
        className="mb-1 flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] outline-none hover:bg-[var(--border-subtle)] focus-visible:ring-2 focus-visible:ring-current"
        style={{ ...secondaryText, ...(overview.open ? { background: "var(--bg-surface)", color: "var(--text-primary)" } : {}) }}>
        <LayoutGrid size={13} aria-hidden="true" />
      </button>
      <div role="tablist" aria-label="Open terminals" className="flex min-w-0 items-end gap-1">
        {tabs.map((tab) => {
          const shown = row(tab.key);
          const title = shown?.name ?? "Terminal";
          const selected = selectedKey !== null && tab.terminals.includes(selectedKey);
          const working = tab.terminals.some((key) => row(key)?.status === "working");
          return (
            <div key={tab.id} className="group flex h-7 max-w-[220px] min-w-[120px] items-center gap-1 rounded-t-md border border-b-0 pl-2 pr-1 text-[12px]"
              style={{
                borderColor: selected ? "var(--border-default)" : "transparent",
                background: selected ? "var(--bg-surface)" : "transparent",
              }}>
              <button type="button" role="tab" aria-selected={selected} title={shown ? `${title} — ${shown.machine.name}` : title}
                onClick={() => onSelect(tab.key)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-current">
                {icon(shown)}
                <span className="min-w-0 truncate" style={selected ? undefined : secondaryText}>{title}</span>
                {tab.terminals.length > 1 ? <span className="shrink-0 tabular-nums text-[10px]" style={secondaryText}>{tab.terminals.length}</span> : null}
                {working ? <Loader2 role="img" aria-label="Working" size={11} className="shrink-0 animate-spin" style={{ color: "#3b82f6" }} /> : null}
              </button>
              <Button variant="ghost" aria-label={`Close tab ${title}`} title="Close tab (the terminals keep running)"
                onClick={() => onClose(tab.id)}
                className={`shrink-0 opacity-60 hover:opacity-100 ${COMPACT_ICON_BUTTON_CLASS}`} style={{ ...COMPACT_ICON_BUTTON, width: 20, height: 20 }}>
                <X size={11} aria-hidden="true" />
              </Button>
            </div>
          );
        })}
      </div>
      <Button variant="ghost" aria-label="New terminal tab" title="New terminal (⌘N)" onClick={onNew}
        className={`mb-1 shrink-0 ${COMPACT_ICON_BUTTON_CLASS}`} style={COMPACT_ICON_BUTTON}>
        <Plus size={13} aria-hidden="true" />
      </Button>
    </div>
  );
}
