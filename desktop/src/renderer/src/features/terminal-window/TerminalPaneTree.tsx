// A tab's panes in the Terminal window (spec 2706 layer 6), laid out like
// Herdr: rounded panes with gaps between them, a header on every pane (icon,
// name, where it runs, and split / zoom / close buttons), a blue outline on
// the focused pane, draggable gaps to resize, and drag a pane by its header
// onto another pane's edge to split there.
import { useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Columns2, Maximize2, Minimize2, Rows2, X } from "lucide-react";
import type { PaneDirection, PaneLeaf, PaneNode, PaneTab } from "@matrix-os/ui/terminal-pane-tree";

export interface PaneInfo {
  title: string;
  /** Where it runs (machine, folder or program), shown after the title. */
  detail?: string;
  icon?: ReactNode;
  working?: boolean;
}

export type PaneButton = "split-right" | "split-down" | "zoom" | "close";

export interface TerminalPaneTreeProps {
  tab: PaneTab;
  /** The terminal in a pane; `focused` is the one that takes input. */
  renderPane(leaf: PaneLeaf, focused: boolean): ReactNode;
  paneInfo(leaf: PaneLeaf): PaneInfo;
  /** A pane header button: split, zoom or close that pane. */
  onPaneButton(leafId: string, button: PaneButton): void;
  onFocus(leafId: string): void;
  onResize(splitId: string, ratio: number): void;
  onMove(sourceId: string, targetId: string, edge: PaneDirection): void;
}

export const FOCUS_OUTLINE = "#3b82f6";
const KEYBOARD_STEP = 0.05;
const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };

/** The edge of a pane nearest to a point inside it. */
export function nearestEdge(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): PaneDirection {
  const fromLeft = (x - rect.left) / Math.max(1, rect.width);
  const fromTop = (y - rect.top) / Math.max(1, rect.height);
  const distances: Array<[PaneDirection, number]> = [["left", fromLeft], ["right", 1 - fromLeft], ["up", fromTop], ["down", 1 - fromTop]];
  return distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best))[0];
}

const DROP_ZONE: Record<PaneDirection, React.CSSProperties> = {
  left: { left: 4, top: 4, bottom: 4, width: "calc(50% - 6px)" },
  right: { right: 4, top: 4, bottom: 4, width: "calc(50% - 6px)" },
  up: { left: 4, right: 4, top: 4, height: "calc(50% - 6px)" },
  down: { left: 4, right: 4, bottom: 4, height: "calc(50% - 6px)" },
};

const DROP_LABEL: Record<PaneDirection, string> = { left: "Split left", right: "Split right", up: "Split up", down: "Split down" };

interface DragState {
  source: string | null;
  target: { id: string; edge: PaneDirection } | null;
}

function Divider({ axis, ratio, onResize }: { axis: "row" | "column"; ratio: number; onResize(ratio: number): void }) {
  const dragging = useRef<HTMLElement | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = event.currentTarget.parentElement;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = dragging.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const next = axis === "row" ? (event.clientX - rect.left) / Math.max(1, rect.width) : (event.clientY - rect.top) / Math.max(1, rect.height);
    onResize(next);
  };
  const onPointerUp = () => { dragging.current = null; };
  const back = axis === "row" ? "ArrowLeft" : "ArrowUp";
  const forward = axis === "row" ? "ArrowRight" : "ArrowDown";
  return (
    // The gap between two panes is the divider.
    <div role="separator" tabIndex={0} aria-label="Resize panes" aria-orientation={axis === "row" ? "vertical" : "horizontal"}
      aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(ratio * 100)}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onKeyDown={(event) => {
        if (event.key === back) { event.preventDefault(); onResize(ratio - KEYBOARD_STEP); }
        if (event.key === forward) { event.preventDefault(); onResize(ratio + KEYBOARD_STEP); }
      }}
      className={`shrink-0 rounded outline-none hover:bg-[var(--border-default)] focus-visible:bg-[var(--border-default)] ${axis === "row" ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize"}`} />
  );
}

const PANE_BUTTONS: Array<{ id: PaneButton; label: string; keys: string }> = [
  { id: "split-right", label: "Split right", keys: "⌘D" },
  { id: "split-down", label: "Split down", keys: "⌘⇧D" },
  { id: "zoom", label: "Zoom", keys: "⌘⇧↩" },
  { id: "close", label: "Close", keys: "⌘W" },
];

function ButtonIcon({ id, zoomed }: { id: PaneButton; zoomed: boolean }) {
  if (id === "split-right") return <Columns2 size={12} aria-hidden="true" />;
  if (id === "split-down") return <Rows2 size={12} aria-hidden="true" />;
  if (id === "zoom") return zoomed ? <Minimize2 size={12} aria-hidden="true" /> : <Maximize2 size={12} aria-hidden="true" />;
  return <X size={12} aria-hidden="true" />;
}

function PaneButtons({ title, zoomed, onButton }: { title: string; zoomed: boolean; onButton(button: PaneButton): void }) {
  return (
    <span className="flex shrink-0 items-center">
      {PANE_BUTTONS.map((button) => {
        const label = button.id === "zoom" && zoomed ? "Restore" : button.label;
        return (
          <button key={button.id} type="button" title={`${label} (${button.keys})`} aria-label={`${label} pane ${title}`}
            onClick={() => onButton(button.id)}
            className="flex size-6 items-center justify-center rounded outline-none hover:bg-[var(--border-subtle)] focus-visible:ring-2 focus-visible:ring-current"
            style={secondaryText}>
            <ButtonIcon id={button.id} zoomed={zoomed} />
          </button>
        );
      })}
    </span>
  );
}

function PaneHeader({ leaf, info, zoomed, props, setDrag }: {
  leaf: PaneLeaf; info: PaneInfo; zoomed: boolean; props: TerminalPaneTreeProps; setDrag(next: DragState): void;
}) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-b px-1 text-[11px]"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
      {/* The title is the drag handle; Escape or a drop outside any pane ends a drag with no change. */}
      <button type="button" draggable aria-label={`Move ${info.title}`} title="Drag onto another pane to split there"
        onDragStart={(event) => {
          event.dataTransfer?.setData("text/plain", leaf.id);
          setDrag({ source: leaf.id, target: null });
        }}
        onDragEnd={() => setDrag({ source: null, target: null })}
        onClick={() => props.onFocus(leaf.id)}
        className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 rounded px-1 py-0.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-current">
        {info.icon ?? null}
        <span className="shrink-0 truncate font-medium" style={{ color: "var(--text-primary)", maxWidth: "60%" }}>{info.title}</span>
        {info.working ? <span role="img" aria-label="Working" className="size-1.5 shrink-0 animate-pulse rounded-full" style={{ background: FOCUS_OUTLINE }} /> : null}
        {info.detail ? <span className="min-w-0 truncate" style={secondaryText}>{info.detail}</span> : null}
      </button>
      <PaneButtons title={info.title} zoomed={zoomed} onButton={(button) => props.onPaneButton(leaf.id, button)} />
    </div>
  );
}

function Pane({ leaf, props, drag, setDrag }: {
  leaf: PaneLeaf; props: TerminalPaneTreeProps; drag: DragState; setDrag(next: DragState): void;
}) {
  const focused = props.tab.focus === leaf.id;
  const info = props.paneInfo(leaf);
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!drag.source || drag.source === leaf.id) return;
    event.preventDefault();
    const edge = nearestEdge(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
    if (drag.target?.id !== leaf.id || drag.target.edge !== edge) setDrag({ ...drag, target: { id: leaf.id, edge } });
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (drag.source && drag.target?.id === leaf.id) props.onMove(drag.source, leaf.id, drag.target.edge);
    setDrag({ source: null, target: null });
  };
  const dropEdge = drag.target?.id === leaf.id ? drag.target.edge : null;
  const zoom = props.tab.zoom;
  const zoomed = zoom === leaf.id;
  const dragging = drag.source === leaf.id;
  return (
    <section aria-label={info.title} data-pane={leaf.id} data-focused={focused || undefined} data-zoomed={zoomed || undefined}
      aria-hidden={zoom && !zoomed ? true : undefined} inert={zoom && !zoomed ? true : undefined}
      onDragOver={onDragOver} onDrop={onDrop}
      onDragLeave={(event) => {
        if (dropEdge && !event.currentTarget.contains(event.relatedTarget as Node | null)) setDrag({ ...drag, target: null });
      }}
      className={`${zoomed ? "absolute inset-1.5 z-10" : "relative"} flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border`}
      style={{
        borderColor: focused ? FOCUS_OUTLINE : "var(--border-subtle)",
        boxShadow: focused ? `0 0 0 1px ${FOCUS_OUTLINE}` : undefined,
        background: "var(--bg-surface)",
        opacity: dragging ? 0.55 : undefined,
      }}>
      <PaneHeader leaf={leaf} info={info} zoomed={zoomed} props={props} setDrag={setDrag} />
      <div className="relative flex min-h-0 min-w-0 flex-1" onPointerDownCapture={() => { if (!focused) props.onFocus(leaf.id); }}>
        {props.renderPane(leaf, focused)}
      </div>
      {dropEdge ? (
        // A solid preview of where the dragged pane lands.
        <div aria-hidden="true" data-drop-edge={dropEdge}
          className="pointer-events-none absolute flex items-center justify-center rounded-md border-2 border-dashed text-[11px] font-medium"
          style={{
            ...DROP_ZONE[dropEdge],
            borderColor: FOCUS_OUTLINE,
            color: FOCUS_OUTLINE,
            background: `color-mix(in srgb, ${FOCUS_OUTLINE} 22%, var(--bg-surface))`,
          }}>
          {DROP_LABEL[dropEdge]}
        </div>
      ) : null}
    </section>
  );
}

function Node({ node, props, drag, setDrag }: { node: PaneNode; props: TerminalPaneTreeProps; drag: DragState; setDrag(next: DragState): void }) {
  if (node.type === "leaf") return <Pane leaf={node} props={props} drag={drag} setDrag={setDrag} />;
  return (
    <div className={`flex min-h-0 min-w-0 flex-1 ${node.axis === "row" ? "flex-row" : "flex-col"}`}>
      <div className="flex min-h-0 min-w-0" style={{ flex: `${node.ratio} 1 0` }}>
        <Node node={node.first} props={props} drag={drag} setDrag={setDrag} />
      </div>
      <Divider axis={node.axis} ratio={node.ratio} onResize={(ratio) => props.onResize(node.id, ratio)} />
      <div className="flex min-h-0 min-w-0" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <Node node={node.second} props={props} drag={drag} setDrag={setDrag} />
      </div>
    </div>
  );
}

export function TerminalPaneTree(props: TerminalPaneTreeProps) {
  const [drag, setDrag] = useState<DragState>({ source: null, target: null });
  // Zoom lays the zoomed pane over the others instead of unmounting them, so
  // every pane keeps its terminal and screen.
  return (
    <main aria-label="Terminal" className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden p-1.5" style={{ background: "var(--bg-app, var(--bg-sunken))" }}>
      <Node node={props.tab.root} props={props} drag={drag} setDrag={setDrag} />
    </main>
  );
}
