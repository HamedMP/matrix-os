import { Focus, LayoutGrid, Minus, Monitor, Plus } from "lucide-react";
import { NATIVE_DESKTOP_LAYOUT } from "../../design/layering";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import AccountMenu from "../mission-control/AccountMenu";
import {
  MAX_CANVAS_ZOOM,
  MIN_CANVAS_ZOOM,
  useNativeDesktopMode,
  type NativeDesktopMode,
} from "../../stores/native-desktop-mode";

const MODES: Array<{
  id: NativeDesktopMode;
  label: string;
  icon: typeof Monitor;
}> = [
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "canvas", label: "Canvas", icon: LayoutGrid },
];

function fitCanvasApps(): void {
  const visible = Object.values(useDesktopSurfaces.getState().surfaces)
    .filter((surface) => surface.mode !== "closed" && surface.mode !== "minimized");
  if (visible.length === 0) {
    useNativeDesktopMode.getState().resetCanvasTransform();
    return;
  }

  const minX = Math.min(...visible.map((surface) => surface.bounds.x));
  const minY = Math.min(...visible.map((surface) => surface.bounds.y));
  const maxX = Math.max(...visible.map((surface) => surface.bounds.x + surface.bounds.width));
  const maxY = Math.max(...visible.map((surface) => surface.bounds.y + surface.bounds.height));
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  const viewportWidth = Math.max(1, window.innerWidth - 96);
  const viewportHeight = Math.max(
    1,
    window.innerHeight - NATIVE_DESKTOP_LAYOUT.taskbarReservedHeight - 96,
  );
  const zoom = Math.min(
    1.5,
    MAX_CANVAS_ZOOM,
    Math.max(MIN_CANVAS_ZOOM, Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight)),
  );
  useNativeDesktopMode.getState().setCanvasTransform({
    zoom,
    panX: (window.innerWidth - contentWidth * zoom) / 2 - minX * zoom,
    panY: (viewportHeight - contentHeight * zoom) / 2 - minY * zoom + 48,
  });
}

function CanvasButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="flex size-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-35"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default function DesktopModeControls() {
  const mode = useNativeDesktopMode((state) => state.mode);
  const zoom = useNativeDesktopMode((state) => state.zoom);
  const setMode = useNativeDesktopMode((state) => state.setMode);
  const setCanvasTransform = useNativeDesktopMode((state) => state.setCanvasTransform);
  const resetCanvasTransform = useNativeDesktopMode((state) => state.resetCanvasTransform);

  return (
    <div className="no-drag ml-auto flex shrink-0 items-center gap-1.5 pl-2">
      {mode === "canvas" ? (
        <div
          aria-label="Canvas view controls"
          className="flex h-7 items-center gap-0.5 rounded-full border px-1"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
        >
          <CanvasButton
            label="Zoom Canvas out"
            disabled={zoom <= MIN_CANVAS_ZOOM}
            onClick={() => setCanvasTransform({ zoom: zoom - 0.1 })}
          >
            <Minus size={12} />
          </CanvasButton>
          <button
            type="button"
            aria-label="Reset Canvas view"
            title="Reset Canvas view"
            className="min-w-10 rounded px-1 text-[10px] tabular-nums text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            onClick={resetCanvasTransform}
          >
            {Math.round(zoom * 100)}%
          </button>
          <CanvasButton
            label="Zoom Canvas in"
            disabled={zoom >= MAX_CANVAS_ZOOM}
            onClick={() => setCanvasTransform({ zoom: zoom + 0.1 })}
          >
            <Plus size={12} />
          </CanvasButton>
          <CanvasButton label="Fit Canvas apps" onClick={fitCanvasApps}>
            <Focus size={12} />
          </CanvasButton>
        </div>
      ) : null}
      <div
        aria-label="Workspace mode"
        className="flex h-7 items-center gap-0.5 rounded-full border p-0.5"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-hover)" }}
      >
        {MODES.map(({ id, label, icon: Icon }) => {
          const active = mode === id;
          return (
            <button
              key={id}
              type="button"
              aria-label={`${label} mode`}
              aria-pressed={active}
              title={`${label} mode`}
              className="flex h-6 items-center gap-1.5 rounded-full px-2 text-[11px] transition-colors"
              style={{
                color: active ? "var(--text-primary)" : "var(--text-tertiary)",
                background: active ? "var(--bg-surface)" : "transparent",
                boxShadow: active ? "var(--shadow-1)" : "none",
              }}
              onClick={() => setMode(id)}
            >
              <Icon size={12} aria-hidden="true" />
              <span className="hidden xl:inline">{label}</span>
            </button>
          );
        })}
      </div>
      <AccountMenu collapsed compact />
    </div>
  );
}
