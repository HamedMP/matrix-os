// Herdr's Spaces in the Terminal window (spec 2706). Each machine is a space
// of its own: one row with a colored letter (or icon) badge, its name, what it
// is and whether it can be used now, `+` and a status dot. A computer's real
// projects (other than its reserved main workspace) are spaces under it,
// behind a chevron that only machines with projects have. Choosing a row shows
// only its terminals; "All" shows every one. Every row can be renamed,
// recolored, given an icon and moved or dragged into order; that dressing is
// the viewer's own and never renames the machine or project.
import { useState, type DragEvent, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { SPACE_COLORS, type SpaceStyle } from "./use-sidebar-prefs";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
// The active space's tint: clear in both themes (the design tokens' --bg-selected is nearly invisible here).
const SELECTED_BG = "rgba(127,127,127,0.18)";
const smallButton = "no-drag flex size-5 shrink-0 items-center justify-center rounded outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50";
const SPACE_COLOR_NAMES: Record<(typeof SPACE_COLORS)[number], string> = {
  "#6366f1": "Indigo", "#0ea5e9": "Sky", "#10b981": "Green", "#f59e0b": "Amber",
  "#ef4444": "Red", "#ec4899": "Pink", "#8b5cf6": "Violet", "#64748b": "Slate",
};
const menuItem = "flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] outline-none data-[highlighted]:bg-[var(--bg-hover)]";

/** A machine's project, as a space under it. */
export interface SpaceItem {
  /** `machineId|space`, the key its dressing is kept under. */
  id: string;
  space: string;
  count: number;
}

export function spaceId(machineId: string, space: string): string {
  return `${machineId}|${space}`;
}

/** Items in the person's order, then any new ones as they came. */
export function inOrder<T>(items: readonly T[], keyOf: (item: T) => string, order: readonly string[] | undefined): T[] {
  if (!order || order.length === 0) return [...items];
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...items].sort((left, right) => (rank.get(keyOf(left)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(keyOf(right)) ?? Number.MAX_SAFE_INTEGER));
}

/** A machine's projects in the person's order. */
export function orderedSpaces(spaces: ReadonlyArray<{ space: string; count: number }>, machineId: string, order: readonly string[] | undefined): SpaceItem[] {
  return inOrder(spaces.map(({ space, count }) => ({ id: spaceId(machineId, space), space, count })), (item) => item.space, order);
}

/** The avatar's color when the person picked none: steady for a name. */
export function defaultSpaceColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SPACE_COLORS[hash % SPACE_COLORS.length]!;
}

function SpaceAvatar({ label, style }: { label: string; style?: SpaceStyle }) {
  const color = style?.color ?? defaultSpaceColor(label);
  const text = style?.icon ?? (label.trim()[0] ?? "?").toUpperCase();
  return (
    <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[9px] font-bold leading-none text-white"
      style={{ background: style?.icon ? "transparent" : color, fontSize: style?.icon ? 12 : undefined }}>
      {text}
    </span>
  );
}

function SpaceMenu({ name, style, open, onOpenChange, onStyle, onMove, first, last }: {
  /** The row's own name, before any renaming. */
  name: string; style?: SpaceStyle; open: boolean; onOpenChange(open: boolean): void;
  onStyle(style: SpaceStyle | null): void; onMove(offset: -1 | 1): void; first: boolean; last: boolean;
}) {
  const label = style?.name ?? name;
  const [naming, setNaming] = useState<string | null>(null);
  return (
    <DropdownMenu.Root open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setNaming(null); }}>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={`${label} options`} title="Rename, color, icon, order"
          className={`${smallButton} opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100`} style={secondaryText}>
          <MoreHorizontal size={12} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content aria-label={`${label} options`} align="start" sideOffset={4}
          className="fade-in min-w-[200px] rounded-lg border p-1"
          style={{ zIndex: DESKTOP_Z_INDEX.popover, background: "var(--bg-overlay)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-2)" }}>
          {naming === null ? (
            <DropdownMenu.Item className={menuItem} style={{ color: "var(--text-primary)" }}
              onSelect={(event) => { event.preventDefault(); setNaming(label); }}>Rename…</DropdownMenu.Item>
          ) : (
            <form className="px-1.5 py-1" onSubmit={(event) => {
              event.preventDefault();
              const next = naming.trim();
              onStyle({ ...style, name: next && next !== name ? next.slice(0, 64) : undefined });
              setNaming(null);
              onOpenChange(false);
            }}>
              {/* react-doctor-disable-next-line react-doctor/no-autofocus -- the person just chose Rename */}
              <input aria-label="Space name" value={naming} maxLength={64} autoFocus onChange={(event) => setNaming(event.target.value)}
                onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}
                className="w-full rounded border bg-transparent px-1.5 py-0.5 text-[12px] outline-none" style={{ borderColor: "var(--border-default)" }} />
            </form>
          )}
          <div role="group" aria-label="Space color" className="flex flex-wrap gap-1 px-2.5 py-1.5">
            {SPACE_COLORS.map((color) => (
              <DropdownMenu.Item key={color} aria-label={`${SPACE_COLOR_NAMES[color]} color`} onSelect={() => onStyle({ ...style, color, icon: undefined })}
                className="size-4 cursor-default rounded-[4px] outline-none data-[highlighted]:ring-2 data-[highlighted]:ring-current"
                style={{ background: color, boxShadow: (style?.color ?? defaultSpaceColor(label)) === color ? "0 0 0 2px var(--text-primary)" : undefined }} />
            ))}
          </div>
          <div role="group" aria-label="Space icon" className="flex flex-wrap gap-1 px-2.5 pb-1.5">
            {["🚀", "🧪", "📦", "🛠️", "🌐", "📝", "🤖", "🔥"].map((icon) => (
              <DropdownMenu.Item key={icon} aria-label={`${icon} icon`} onSelect={() => onStyle({ ...style, icon })}
                className="flex size-5 cursor-default items-center justify-center rounded text-[13px] outline-none data-[highlighted]:bg-[var(--bg-hover)]">
                {icon}
              </DropdownMenu.Item>
            ))}
          </div>
          <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
          <DropdownMenu.Item className={menuItem} disabled={first} onSelect={() => onMove(-1)} style={{ color: "var(--text-primary)" }}>Move up</DropdownMenu.Item>
          <DropdownMenu.Item className={menuItem} disabled={last} onSelect={() => onMove(1)} style={{ color: "var(--text-primary)" }}>Move down</DropdownMenu.Item>
          {style ? (
            <DropdownMenu.Item className={menuItem} onSelect={() => onStyle(null)} style={{ color: "var(--text-primary)" }}>Reset look</DropdownMenu.Item>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** One row of Spaces: a machine, or a project on it. */
export interface SpaceEntry {
  /** The key its dressing and order are kept under. */
  id: string;
  /** Its own name, before any renaming. */
  name: string;
  count: number;
  /** What it is and whether it can be used now (machines). */
  detail?: string;
  dotColor?: string;
  /** `+` (a new terminal there) and other actions, before the menu. */
  actions?: ReactNode;
  selected: boolean;
  /** Can be chosen now (an unavailable machine cannot). */
  available: boolean;
  onSelect(): void;
  /** What its chevron lists under it; no chevron without it. */
  expansion?: { label: string; content: ReactNode };
  /** Shown under the row (a machine's failure, retry or sign-in hand-off). */
  status?: ReactNode;
}

/**
 * Rows of Spaces: click a row to show only its terminals, its chevron (when it
 * has one) to list what is inside it, the menu or a right-click to dress it,
 * drag to reorder.
 */
export function SpaceList({ label, entries, styles, expanded, onToggleExpanded, onStyle, onReorder, indent = false }: {
  label: string;
  entries: readonly SpaceEntry[];
  styles: Readonly<Record<string, SpaceStyle>>;
  expanded: readonly string[];
  onToggleExpanded(id: string): void;
  onStyle(id: string, style: SpaceStyle | null): void;
  onReorder(ids: string[]): void;
  /** A machine's projects sit inset under it. */
  indent?: boolean;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const open = new Set(expanded);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= entries.length || from === to) return;
    const order = entries.map((entry) => entry.id);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved!);
    onReorder(order);
  };
  return (
    <ul aria-label={label} className={`flex flex-col${indent ? " pl-4" : ""}`}>
      {entries.map((entry, index) => {
        const style = styles[entry.id];
        const shownName = style?.name ?? entry.name;
        const shown = Boolean(entry.expansion) && open.has(entry.id);
        return (
          <li key={entry.id} data-space={entry.id} className="flex flex-col">
            <div draggable
              onDragStart={(event: DragEvent<HTMLDivElement>) => { event.dataTransfer?.setData("text/plain", entry.id); setDragging(entry.id); }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => { if (dragging && dragging !== entry.id) event.preventDefault(); }}
              onDrop={(event) => {
                event.preventDefault();
                const from = entries.findIndex((candidate) => candidate.id === dragging);
                if (from >= 0) move(from, index);
                setDragging(null);
              }}
              onContextMenu={(event) => { event.preventDefault(); setMenuFor(entry.id); }}
              className="group flex h-6 items-center gap-0.5 rounded-md pl-0.5 pr-0.5 hover:bg-black/5"
              style={{ background: entry.selected ? SELECTED_BG : undefined, opacity: dragging === entry.id ? 0.5 : undefined }}>
              {entry.expansion ? (
                <button type="button" aria-expanded={shown} aria-label={`${shown ? "Hide" : "Show"} ${entry.expansion.label}`}
                  onClick={() => onToggleExpanded(entry.id)} className={smallButton} style={secondaryText}>
                  {shown ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
                </button>
              ) : <span aria-hidden="true" className="size-5 shrink-0" />}
              <button type="button" aria-pressed={entry.selected} disabled={!entry.available}
                title={shownName === entry.name ? entry.name : `${shownName} (${entry.name})`} onClick={entry.onSelect}
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-current disabled:opacity-60"
                style={{ color: "var(--text-primary)" }}>
                <SpaceAvatar label={shownName} style={style} />
                <span className="shrink-0 truncate" style={{ maxWidth: entry.detail ? "55%" : undefined }}>{shownName}</span>
                {entry.detail ? <span className="min-w-0 flex-1 truncate text-[10px]" style={secondaryText}>{entry.detail}</span> : <span className="flex-1" />}
                {entry.count > 0 ? <span className="shrink-0 text-[10px] tabular-nums group-hover:hidden" style={secondaryText}>{entry.count}</span> : null}
              </button>
              {entry.actions ?? null}
              {entry.dotColor ? <span aria-hidden="true" className="mx-1 size-1.5 shrink-0 rounded-full" style={{ background: entry.dotColor }} /> : null}
              <SpaceMenu name={entry.name} style={style} open={menuFor === entry.id} onOpenChange={(next) => setMenuFor(next ? entry.id : null)}
                onStyle={(next) => onStyle(entry.id, next)} onMove={(offset) => move(index, index + offset)}
                first={index === 0} last={index === entries.length - 1} />
            </div>
            {entry.status ?? null}
            {shown ? entry.expansion!.content : null}
          </li>
        );
      })}
    </ul>
  );
}

/** "All": every machine's terminals, the state with no space chosen. */
export function AllSpacesRow({ chosen, count, onChoose }: { chosen: boolean; count: number; onChoose(): void }) {
  return (
    <button type="button" aria-pressed={chosen} onClick={onChoose}
      className="flex h-6 w-full items-center gap-2 rounded-md pl-1.5 pr-2 text-left text-[12px] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current"
      style={{ background: chosen ? SELECTED_BG : undefined, color: "var(--text-primary)" }}>
      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border text-[9px] font-bold" style={secondaryText}>∗</span>
      <span className="min-w-0 flex-1 truncate">All</span>
      <span className="shrink-0 text-[10px] tabular-nums" style={secondaryText}>{count}</span>
    </button>
  );
}

