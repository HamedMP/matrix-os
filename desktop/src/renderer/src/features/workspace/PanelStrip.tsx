import { useCallback, useMemo, useRef } from "react";
import {
  useWorkspace,
  defaultLayout,
  PANEL_MIN_PCT,
  type PanelKind,
  type PanelLayout,
} from "../../stores/workspace";

export const PANEL_TITLES: Record<PanelKind, string> = {
  terminal: "Terminal",
  editor: "Editor",
  git: "Git",
  browser: "Browser",
  artifacts: "Artifacts",
  processes: "Processes",
};

interface PanelStripProps {
  taskId: string;
  renderPanel: (panel: PanelKind) => React.ReactNode;
}

export default function PanelStrip({ taskId, renderPanel }: PanelStripProps) {
  const layouts = useWorkspace((s) => s.layouts);
  const setPanelSizes = useWorkspace((s) => s.setPanelSizes);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{
    left: PanelKind;
    right: PanelKind;
    startX: number;
    startSizes: Record<PanelKind, number>;
    latestSizes: Record<PanelKind, number> | null;
  } | null>(null);

  const layout: PanelLayout = useMemo(() => layouts[taskId] ?? defaultLayout(), [layouts, taskId]);
  const visiblePanels = useMemo(
    () => layout.order.filter((panel) => layout.visible[panel]),
    [layout],
  );

  const onDividerDown = useCallback(
    (left: PanelKind, right: PanelKind, e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragState.current = {
        left,
        right,
        startX: e.clientX,
        startSizes: { ...layout.sizes },
        latestSizes: null,
      };
    },
    [layout.sizes],
  );

  const onDividerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragState.current;
      const container = containerRef.current;
      if (!drag || !container) return;
      const totalWidth = container.getBoundingClientRect().width;
      if (totalWidth <= 0) return;
      const deltaPct = ((e.clientX - drag.startX) / totalWidth) * 100;
      const leftStart = drag.startSizes[drag.left] ?? 0;
      const rightStart = drag.startSizes[drag.right] ?? 0;
      const minLeft = PANEL_MIN_PCT[drag.left];
      const minRight = PANEL_MIN_PCT[drag.right];
      const clamped = Math.max(minLeft - leftStart, Math.min(deltaPct, rightStart - minRight));
      const nextSizes = {
        ...drag.startSizes,
        [drag.left]: leftStart + clamped,
        [drag.right]: rightStart - clamped,
      };
      drag.latestSizes = nextSizes;
      setPanelSizes(taskId, nextSizes, Date.now(), { persist: false });
    },
    [setPanelSizes, taskId],
  );

  const onDividerUp = useCallback(() => {
    const drag = dragState.current;
    dragState.current = null;
    if (drag?.latestSizes) setPanelSizes(taskId, drag.latestSizes);
  }, [setPanelSizes, taskId]);

  if (visiblePanels.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm" style={{ color: "var(--text-tertiary)" }}>
          All panels hidden. Toggle one from the toolbar (⌘1–⌘6).
        </span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1">
      {visiblePanels.map((panel, index) => (
        <div key={panel} className="flex min-h-0 min-w-0" style={{ flexBasis: `${layout.sizes[panel] ?? 100 / visiblePanels.length}%`, flexGrow: 0, flexShrink: 0, display: "flex" }}>
          {index > 0 ? (
            <div
              role="separator"
              aria-orientation="vertical"
              className="w-[5px] shrink-0 cursor-col-resize transition-colors duration-100 hover:bg-[var(--accent-muted)]"
              style={{ background: "var(--border-subtle)", backgroundClip: "padding-box", borderLeft: "2px solid transparent", borderRight: "2px solid transparent" }}
              onPointerDown={(e) => onDividerDown(visiblePanels[index - 1]!, panel, e)}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              onPointerCancel={onDividerUp}
              onLostPointerCapture={onDividerUp}
            />
          ) : null}
          <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={PANEL_TITLES[panel]}>
            <header
              className="flex h-7 shrink-0 items-center border-b px-2.5 text-xs font-semibold tracking-wide uppercase"
              style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)", background: "var(--bg-surface)" }}
            >
              {PANEL_TITLES[panel]}
            </header>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">{renderPanel(panel)}</div>
          </section>
        </div>
      ))}
    </div>
  );
}
