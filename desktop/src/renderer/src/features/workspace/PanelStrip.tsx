import { Component, useMemo, type ErrorInfo, type ReactNode } from "react";
import { Group, Panel, Separator, type Layout as GroupLayout } from "react-resizable-panels";
import {
  useWorkspace,
  defaultLayout,
  normalizeLayout,
  PANEL_MIN_PCT,
  type PanelKind,
  type PanelLayout,
} from "../../stores/workspace";

export const PANEL_TITLES: Record<PanelKind, string> = {
  terminal: "Terminal",
  editor: "Editor",
  git: "Git",
  browser: "Files",
  artifacts: "Preview",
  processes: "Processes",
  timeline: "Timeline",
};

export class PanelErrorBoundary extends Component<{
  children: ReactNode;
  panel: PanelKind;
}, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(
      `[task-workspace] ${this.props.panel} panel failed (${error.name}; component stack: ${info.componentStack ? "present" : "missing"})`,
    );
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm"
        style={{ color: "var(--text-secondary)" }}
      >
        {PANEL_TITLES[this.props.panel]} panel couldn&apos;t open.
      </div>
    );
  }
}

interface PanelStripProps {
  taskId: string;
  renderPanel: (panel: PanelKind) => React.ReactNode;
}

export function groupLayoutForPanels(
  visiblePanels: PanelKind[],
  sizes: Record<PanelKind, number>,
): GroupLayout {
  const even = visiblePanels.length ? 100 / visiblePanels.length : 0;
  const next: GroupLayout = {};
  for (const panel of visiblePanels) {
    next[panel] = sizes[panel] || even;
  }
  return next;
}

export function panelSizesFromGroupLayout(
  visiblePanels: PanelKind[],
  nextLayout: GroupLayout,
  previousSizes: Record<PanelKind, number>,
): Record<PanelKind, number> {
  const next = { ...previousSizes };
  visiblePanels.forEach((panel) => {
    const value = nextLayout[panel];
    if (typeof value === "number" && Number.isFinite(value)) {
      next[panel] = value;
    }
  });
  return next;
}

export default function PanelStrip({ taskId, renderPanel }: PanelStripProps) {
  const layouts = useWorkspace((s) => s.layouts);
  const setPanelSizes = useWorkspace((s) => s.setPanelSizes);

  const layout: PanelLayout = useMemo(() => normalizeLayout(layouts[taskId] ?? defaultLayout()), [layouts, taskId]);
  const visiblePanels = useMemo(() => layout.order.filter((panel) => layout.visible[panel]), [layout]);

  // Remount the group when the visible set changes so default sizes re-apply.
  const groupKey = visiblePanels.join("-");

  // react-resizable-panels v4 layouts are keyed by rendered panel id.
  // The workspace store persists them keyed by panel id.
  const defaultGroupLayout = useMemo(() => {
    return groupLayoutForPanels(visiblePanels, layout.sizes);
  }, [visiblePanels, layout.sizes]);

  if (visiblePanels.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm" style={{ color: "var(--text-tertiary)" }}>
          All panels hidden. Toggle one from the toolbar (⌘1–⌘7).
        </span>
      </div>
    );
  }

  return (
    <Group
      key={groupKey}
      orientation="horizontal"
      defaultLayout={defaultGroupLayout}
      onLayoutChange={(next) =>
        setPanelSizes(taskId, panelSizesFromGroupLayout(visiblePanels, next, layout.sizes))
      }
      className="flex min-h-0 min-w-0 flex-1"
    >
      {visiblePanels.map((panel, index) => (
        <PanelHost key={panel} panel={panel} showSeparator={index > 0} renderPanel={renderPanel} />
      ))}
    </Group>
  );
}

function PanelHost({
  panel,
  showSeparator,
  renderPanel,
}: {
  panel: PanelKind;
  showSeparator: boolean;
  renderPanel: (panel: PanelKind) => React.ReactNode;
}) {
  return (
    <>
      {showSeparator ? (
        <Separator className="group/sep relative w-px shrink-0 cursor-col-resize outline-none" style={{ background: "var(--border-subtle)" }}>
          <span className="absolute inset-y-0 -left-1 -right-1 transition-colors duration-100 group-hover/sep:bg-[var(--accent-muted)]" />
        </Separator>
      ) : null}
      {/* react-resizable-panels v4 reads numeric minSize as PIXELS; percent
          sizes must be strings or panels clamp to tiny pixel boxes. */}
      <Panel id={panel} minSize={`${PANEL_MIN_PCT[panel]}%`} className="flex min-h-0 min-w-0 flex-col">
        <header
          className="flex h-7 shrink-0 items-center border-b px-2.5 text-xs font-semibold tracking-wide uppercase"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)", background: "var(--bg-surface)" }}
        >
          {PANEL_TITLES[panel]}
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <PanelErrorBoundary panel={panel}>{renderPanel(panel)}</PanelErrorBoundary>
        </div>
      </Panel>
    </>
  );
}
