// A tab's panes in the Terminal window (spec 2706 layer 6), laid out like
// Herdr: rounded panes with gaps between them, a header on every pane (icon,
// name, where it runs, and split / zoom / close buttons), a blue outline on
// the focused pane, draggable gaps to resize, and drag a pane by its header
// onto another pane's edge to split there.
import { useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { Columns2, Maximize2, Minimize2, Rows2, X } from "lucide-react";
import {
  leaves, paneRects, splitFrames, type PaneDirection, type PaneLeaf, type PaneRect, type PaneTab, type SplitFrame,
} from "@matrix-os/ui/terminal-pane-tree";

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
const GAP_PX = 6;
const EPSILON = 1e-6;
const FULL: PaneRect = { x: 0, y: 0, width: 1, height: 1 };
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

/** Where a unit-square rectangle sits in the panes area, leaving a gap between neighbours. */
function placed(rect: PaneRect): CSSProperties {
  const half = GAP_PX / 2;
  const startX = rect.x > EPSILON ? half : 0;
  const endX = rect.x + rect.width < 1 - EPSILON ? half : 0;
  const startY = rect.y > EPSILON ? half : 0;
  const endY = rect.y + rect.height < 1 - EPSILON ? half : 0;
  return {
    position: "absolute",
    left: `calc(${rect.x * 100}% + ${startX}px)`,
    top: `calc(${rect.y * 100}% + ${startY}px)`,
    width: `calc(${rect.width * 100}% - ${startX + endX}px)`,
    height: `calc(${rect.height * 100}% - ${startY + endY}px)`,
  };
}

function Divider({ frame, area, covered, onResize }: {
  frame: SplitFrame; area: RefObject<HTMLDivElement | null>; covered: boolean; onResize(ratio: number): void;
}) {
  const { axis, ratio, rect } = frame;
  const dragging = useRef(false);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = area.current?.getBoundingClientRect();
    if (!dragging.current || !box) return;
    // The pointer's place within this split's own rectangle.
    const next = axis === "row"
      ? ((event.clientX - box.left) / Math.max(1, box.width) - rect.x) / Math.max(EPSILON, rect.width)
      : ((event.clientY - box.top) / Math.max(1, box.height) - rect.y) / Math.max(EPSILON, rect.height);
    onResize(next);
  };
  const onPointerUp = () => { dragging.current = false; };
  const back = axis === "row" ? "ArrowLeft" : "ArrowUp";
  const forward = axis === "row" ? "ArrowRight" : "ArrowDown";
  const at = axis === "row" ? rect.x + rect.width * ratio : rect.y + rect.height * ratio;
  const style: CSSProperties = axis === "row"
    ? { position: "absolute", left: `calc(${at * 100}% - ${GAP_PX / 2}px)`, width: GAP_PX, top: `${rect.y * 100}%`, height: `${rect.height * 100}%` }
    : { position: "absolute", top: `calc(${at * 100}% - ${GAP_PX / 2}px)`, height: GAP_PX, left: `${rect.x * 100}%`, width: `${rect.width * 100}%` };
  return (
    // The gap between two panes is the divider.
    // Under a zoomed pane it takes no focus, keys or pointer, so the hidden layout cannot change.
    <div role="separator" tabIndex={covered ? -1 : 0} aria-hidden={covered || undefined} inert={covered || undefined}
      aria-label="Resize panes" aria-orientation={axis === "row" ? "vertical" : "horizontal"}
      aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(ratio * 100)}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onKeyDown={(event) => {
        if (covered) return;
        if (event.key === back) { event.preventDefault(); onResize(ratio - KEYBOARD_STEP); }
        if (event.key === forward) { event.preventDefault(); onResize(ratio + KEYBOARD_STEP); }
      }}
      style={style}
      className={`rounded outline-none hover:bg-[var(--border-default)] focus-visible:bg-[var(--border-default)] ${axis === "row" ? "cursor-col-resize" : "cursor-row-resize"}`} />
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

function Pane({ leaf, rect, props, drag, setDrag }: {
  leaf: PaneLeaf; rect: PaneRect; props: TerminalPaneTreeProps; drag: DragState; setDrag(next: DragState): void;
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
    <section aria-label={info.title} data-pane={leaf.id} data-terminal={leaf.terminal} data-focused={focused || undefined} data-zoomed={zoomed || undefined}
      aria-hidden={zoom && !zoomed ? true : undefined} inert={zoom && !zoomed ? true : undefined}
      onDragOver={onDragOver} onDrop={onDrop}
      onDragLeave={(event) => {
        if (dropEdge && !event.currentTarget.contains(event.relatedTarget as Node | null)) setDrag({ ...drag, target: null });
      }}
      className={`${zoomed ? "z-10" : ""} flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border`}
      style={{
        ...placed(zoomed ? FULL : rect),
        borderColor: focused ? FOCUS_OUTLINE : "var(--border-subtle)",
        boxShadow: focused ? `0 0 0 1px ${FOCUS_OUTLINE}` : undefined,
        background: "var(--bg-surface)",
        opacity: dragging ? 0.55 : undefined,
      }}>
      <PaneHeader leaf={leaf} info={info} zoomed={zoomed} props={props} setDrag={setDrag} />
      {/* A click or keyboard focus (Tab, the find bar) inside a pane makes it the focused pane. */}
      <div className="relative flex min-h-0 min-w-0 flex-1" onPointerDownCapture={() => { if (!focused) props.onFocus(leaf.id); }}
        onFocusCapture={() => { if (!focused) props.onFocus(leaf.id); }}>
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

export function TerminalPaneTree(props: TerminalPaneTreeProps) {
  const [drag, setDrag] = useState<DragState>({ source: null, target: null });
  const area = useRef<HTMLDivElement>(null);
  const rects = paneRects(props.tab.root);
  // Every pane is a keyed child of one area, placed from the tree: a split,
  // close or move changes only its place, so its terminal is never remounted
  // (a remount would drop its screen). Zoom lays the zoomed pane over the others.
  return (
    <main aria-label="Terminal" className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden p-1.5" style={{ background: "var(--bg-app, var(--bg-sunken))" }}>
      <div ref={area} className="relative min-h-0 min-w-0 flex-1">
        {leaves(props.tab.root).map((leaf) => (
          // Keyed by terminal, which a tab holds at most once: leaf ids change when a lone terminal first splits.
          <Pane key={leaf.terminal} leaf={leaf} rect={rects.get(leaf.id) ?? FULL} props={props} drag={drag} setDrag={setDrag} />
        ))}
        {splitFrames(props.tab.root).map((frame) => (
          <Divider key={frame.id} frame={frame} area={area} covered={props.tab.zoom !== null} onResize={(ratio) => props.onResize(frame.id, ratio)} />
        ))}
      </div>
    </main>
  );
}
