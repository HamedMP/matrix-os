// A tab's panes in the Terminal window (spec 2706 layer 6): rows and columns
// with draggable dividers, one terminal per pane, zoom, and drag a pane by its
// header onto another pane's edge to split there.
import { useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { PaneDirection, PaneLeaf, PaneNode, PaneTab } from "@matrix-os/ui/terminal-pane-tree";

export interface TerminalPaneTreeProps {
  tab: PaneTab;
  /** The terminal in a pane; `focused` is the one that takes input. */
  renderPane(leaf: PaneLeaf, focused: boolean): ReactNode;
  paneTitle(leaf: PaneLeaf): string;
  onFocus(leafId: string): void;
  onResize(splitId: string, ratio: number): void;
  onMove(sourceId: string, targetId: string, edge: PaneDirection): void;
}

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
  left: { left: 0, top: 0, bottom: 0, width: "50%" },
  right: { right: 0, top: 0, bottom: 0, width: "50%" },
  up: { left: 0, right: 0, top: 0, height: "50%" },
  down: { left: 0, right: 0, bottom: 0, height: "50%" },
};

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
    <div role="separator" tabIndex={0} aria-label="Resize panes" aria-orientation={axis === "row" ? "vertical" : "horizontal"}
      aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(ratio * 100)}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onKeyDown={(event) => {
        if (event.key === back) { event.preventDefault(); onResize(ratio - KEYBOARD_STEP); }
        if (event.key === forward) { event.preventDefault(); onResize(ratio + KEYBOARD_STEP); }
      }}
      className={`shrink-0 outline-none focus-visible:bg-[var(--border-default)] ${axis === "row" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}`}
      style={{ background: "var(--border-subtle)" }} />
  );
}

function Pane({ leaf, props, drag, setDrag }: {
  leaf: PaneLeaf; props: TerminalPaneTreeProps; drag: DragState; setDrag(next: DragState): void;
}) {
  const focused = props.tab.focus === leaf.id;
  const title = props.paneTitle(leaf);
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!drag.source || drag.source === leaf.id) return;
    event.preventDefault();
    const edge = nearestEdge(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
    if (drag.target?.id !== leaf.id || drag.target.edge !== edge) setDrag({ ...drag, target: { id: leaf.id, edge } });
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (drag.source && drag.target?.id === leaf.id) props.onMove(drag.source, leaf.id, drag.target.edge);
    setDrag({ source: null, target: null });
  };
  const dropEdge = drag.target?.id === leaf.id ? drag.target.edge : null;
  const zoom = props.tab.zoom;
  const zoomed = zoom === leaf.id;
  return (
    <section aria-label={title} data-pane={leaf.id} data-focused={focused || undefined} data-zoomed={zoomed || undefined}
      aria-hidden={zoom && !zoomed ? true : undefined} inert={zoom && !zoomed ? true : undefined}
      onDragOver={onDragOver} onDrop={onDrop}
      onDragLeave={(event) => {
        if (dropEdge && !event.currentTarget.contains(event.relatedTarget as Node | null)) setDrag({ ...drag, target: null });
      }}
      className={`${zoomed ? "absolute inset-0 z-10" : "relative"} flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden`}
      style={{ boxShadow: focused ? "inset 0 0 0 1px var(--accent, var(--border-default))" : undefined, background: zoomed ? "var(--bg-surface)" : undefined }}>
      <button type="button" draggable aria-label={`Move ${title}`} tabIndex={-1}
        onDragStart={(event) => {
          event.dataTransfer?.setData("text/plain", leaf.id);
          setDrag({ source: leaf.id, target: null });
        }}
        // Escape or a drop outside any pane ends the drag with no change.
        onDragEnd={() => setDrag({ source: null, target: null })}
        onPointerDown={() => props.onFocus(leaf.id)}
        className="flex h-6 w-full shrink-0 cursor-grab items-center gap-1.5 border-b px-2 text-left text-[11px] outline-none select-none"
        style={{ ...secondaryText, borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      <div className="relative flex min-h-0 min-w-0 flex-1" onPointerDownCapture={() => { if (!focused) props.onFocus(leaf.id); }}>
        {props.renderPane(leaf, focused)}
      </div>
      {dropEdge ? (
        <div aria-hidden="true" data-drop-edge={dropEdge} className="pointer-events-none absolute"
          style={{ ...DROP_ZONE[dropEdge], background: "color-mix(in srgb, var(--accent, #3b82f6) 22%, transparent)" }} />
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
    <main aria-label="Terminal" className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden" style={{ background: "var(--bg-surface)" }}>
      <Node node={props.tab.root} props={props} drag={drag} setDrag={setDrag} />
    </main>
  );
}
