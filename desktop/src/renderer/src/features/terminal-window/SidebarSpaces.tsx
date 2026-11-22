// Herdr's Spaces in the Terminal window (spec 2706): each machine as a small
// muted header (icon, name, `+`, status dot, fold chevron), its spaces
// (projects or workspaces) under it as compact rows with a colored letter
// avatar. Choosing a space shows only its terminals; "All" shows every one.
// A space can be renamed, recolored, given an icon and dragged into order;
// that dressing is the viewer's own and never renames the project.
import { useState, type DragEvent, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ChevronRight, Cloud, Laptop, Layers, MoreHorizontal } from "lucide-react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { SPACE_COLORS, type SpaceStyle } from "./use-sidebar-prefs";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
const SELECTED_BG = "var(--terminal-drawer-card-selected-bg, rgba(127,127,127,0.18))";
const smallButton = "no-drag flex size-5 shrink-0 items-center justify-center rounded outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50";
const menuItem = "flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] outline-none data-[highlighted]:bg-[var(--bg-hover)]";

export interface SpaceItem {
  /** `machineId|space`, the key its dressing is kept under. */
  id: string;
  space: string;
  count: number;
}

export function spaceId(machineId: string, space: string): string {
  return `${machineId}|${space}`;
}

/** A machine's spaces in the person's order, then any new ones by how many terminals they hold. */
export function orderedSpaces(spaces: ReadonlyArray<{ space: string; count: number }>, machineId: string, order: readonly string[] | undefined): SpaceItem[] {
  const items = spaces.map(({ space, count }) => ({ id: spaceId(machineId, space), space, count }));
  if (!order || order.length === 0) return items;
  const rank = new Map(order.map((space, index) => [space, index]));
  return [...items].sort((left, right) => (rank.get(left.space) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.space) ?? Number.MAX_SAFE_INTEGER));
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

/** One compact header per machine. */
export function MachineHeader({ name, detail, kind, dotColor, folded, canFold, chosen, available, onToggle, onChoose, create }: {
  name: string; detail?: string; kind: "local" | "computer" | "ssh"; dotColor?: string; folded: boolean; canFold: boolean;
  chosen: boolean; available: boolean; onToggle(): void; onChoose(): void; create?: ReactNode;
}) {
  const icon = kind === "local" ? <Laptop size={12} /> : kind === "ssh" ? <Layers size={12} /> : <Cloud size={12} />;
  return (
    <div className="group flex h-6 items-center gap-1 rounded-md pl-1.5 pr-0.5 hover:bg-black/5"
      style={chosen ? { background: SELECTED_BG } : undefined}>
      {/* The machine name shows only that machine's terminals. */}
      <button type="button" aria-pressed={chosen} disabled={!available} onClick={onChoose}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-current disabled:opacity-60"
        style={secondaryText}>
        <span aria-hidden="true" className="shrink-0">{icon}</span>
        <span className="shrink-0 truncate" style={{ maxWidth: "60%" }}>{name}</span>
        {/* What it is and whether it can be used now (Main Computer · Connecting…). */}
        {detail ? <span className="min-w-0 truncate text-[10px] font-normal opacity-80">{detail}</span> : null}
      </button>
      {create ?? null}
      {dotColor ? <span aria-hidden="true" className="mx-0.5 size-1.5 shrink-0 rounded-full" style={{ background: dotColor }} /> : null}
      {/* A machine with no spaces keeps the slot, so every header lines up. */}
      {canFold ? (
        <button type="button" aria-expanded={!folded} aria-label={`${folded ? "Show" : "Hide"} ${name} spaces`}
          onClick={onToggle} className={smallButton} style={secondaryText}>
          {folded ? <ChevronRight size={11} aria-hidden="true" /> : <ChevronDown size={11} aria-hidden="true" />}
        </button>
      ) : <span aria-hidden="true" className="size-5 shrink-0" />}
    </div>
  );
}

function SpaceMenu({ item, style, open, onOpenChange, onStyle, onMove, first, last }: {
  item: SpaceItem; style?: SpaceStyle; open: boolean; onOpenChange(open: boolean): void;
  onStyle(style: SpaceStyle | null): void; onMove(offset: -1 | 1): void; first: boolean; last: boolean;
}) {
  const label = style?.name ?? item.space;
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
              const name = naming.trim();
              onStyle({ ...style, name: name && name !== item.space ? name.slice(0, 64) : undefined });
              setNaming(null);
              onOpenChange(false);
            }}>
              {/* react-doctor-disable-next-line react-doctor/no-autofocus -- the person just chose Rename */}
              <input aria-label="Space name" value={naming} maxLength={64} autoFocus onChange={(event) => setNaming(event.target.value)}
                onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}
                className="w-full rounded border bg-transparent px-1.5 py-0.5 text-[12px] outline-none" style={{ borderColor: "var(--border-default)" }} />
            </form>
          )}
          <div role="group" aria-label="Color" className="flex flex-wrap gap-1 px-2.5 py-1.5">
            {SPACE_COLORS.map((color) => (
              <DropdownMenu.Item key={color} aria-label={`Color ${color}`} onSelect={() => onStyle({ ...style, color, icon: undefined })}
                className="size-4 cursor-default rounded-[4px] outline-none data-[highlighted]:ring-2 data-[highlighted]:ring-current"
                style={{ background: color, boxShadow: (style?.color ?? defaultSpaceColor(item.space)) === color ? "0 0 0 2px var(--text-primary)" : undefined }} />
            ))}
          </div>
          <div role="group" aria-label="Icon" className="flex flex-wrap gap-1 px-2.5 pb-1.5">
            {["🚀", "🧪", "📦", "🛠️", "🌐", "📝", "🤖", "🔥"].map((icon) => (
              <DropdownMenu.Item key={icon} aria-label={`Icon ${icon}`} onSelect={() => onStyle({ ...style, icon })}
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

/** A machine's spaces: click to show only that space, the menu (or right-click) to dress it, drag to reorder. */
export function SpaceRows({ machineName, items, styles, selected, onSelect, onStyle, onReorder }: {
  machineName: string;
  items: readonly SpaceItem[];
  styles: Readonly<Record<string, SpaceStyle>>;
  selected: string | null;
  onSelect(item: SpaceItem | null): void;
  onStyle(id: string, style: SpaceStyle | null): void;
  onReorder(spaces: string[]): void;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const order = items.map((item) => item.space);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved!);
    onReorder(order);
  };
  return (
    <ul aria-label={`${machineName} spaces`} className="flex flex-col pb-0.5">
      {items.map((item, index) => {
        const style = styles[item.id];
        const label = style?.name ?? item.space;
        const on = selected === item.id;
        return (
          <li key={item.id} draggable
            onDragStart={(event: DragEvent<HTMLLIElement>) => { event.dataTransfer?.setData("text/plain", item.id); setDragging(item.id); }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => { if (dragging && dragging !== item.id) event.preventDefault(); }}
            onDrop={(event) => {
              event.preventDefault();
              const from = items.findIndex((candidate) => candidate.id === dragging);
              if (from >= 0) move(from, index);
              setDragging(null);
            }}
            onContextMenu={(event) => { event.preventDefault(); setMenuFor(item.id); }}
            className="group flex h-6 items-center gap-0.5 rounded-md pl-3 pr-0.5 hover:bg-black/5"
            style={{ background: on ? SELECTED_BG : undefined, opacity: dragging === item.id ? 0.5 : undefined }}>
            <button type="button" aria-pressed={on} title={label === item.space ? item.space : `${label} (${item.space})`}
              onClick={() => onSelect(on ? null : item)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-current"
              style={{ color: "var(--text-primary)" }}>
              <SpaceAvatar label={label} style={style} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="shrink-0 text-[10px] tabular-nums group-hover:hidden" style={secondaryText}>{item.count}</span>
            </button>
            <SpaceMenu item={item} style={style} open={menuFor === item.id} onOpenChange={(open) => setMenuFor(open ? item.id : null)}
              onStyle={(next) => onStyle(item.id, next)} onMove={(offset) => move(index, index + offset)}
              first={index === 0} last={index === items.length - 1} />
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

