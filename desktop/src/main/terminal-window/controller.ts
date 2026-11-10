// Owns the single Terminal window: single-flight creation, focus, and bounds
// persistence. Electron specifics are injected so this stays unit-testable.
import type { FittedWindowBounds, WindowBounds } from "../platform/window-bounds";

export interface TerminalWindowLike {
  on(event: "resize" | "move" | "closed", listener: () => void): unknown;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  close(): void;
  getBounds(): { x: number; y: number; width: number; height: number };
}

export interface TerminalWindowControllerOptions<W extends TerminalWindowLike> {
  create(bounds: FittedWindowBounds): W;
  loadBounds(): Promise<Required<WindowBounds> | null>;
  saveBounds(bounds: Required<WindowBounds>): Promise<void>;
  fitBounds(bounds: WindowBounds): FittedWindowBounds;
}

const DEFAULT_BOUNDS: WindowBounds = { width: 1100, height: 720 };
const BOUNDS_SAVE_DELAY_MS = 500;

function logFailure(label: string, error: unknown): void {
  console.warn(`[terminal-window] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

export function createTerminalWindowController<W extends TerminalWindowLike>(
  options: TerminalWindowControllerOptions<W>,
) {
  let current: W | null = null;
  let pending: Promise<void> | null = null;
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearBoundsTimer = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = null;
  };

  const live = (): W | null => (current && !current.isDestroyed() ? current : null);

  const focus = (win: W) => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const scheduleBoundsSave = (win: W) => {
    clearBoundsTimer();
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      if (win.isDestroyed() || current !== win) return;
      const { x, y, width, height } = win.getBounds();
      void options.saveBounds({ x, y, width, height })
        .catch((error: unknown) => logFailure("could not persist bounds", error));
    }, BOUNDS_SAVE_DELAY_MS);
  };

  async function open(): Promise<void> {
    let saved: Required<WindowBounds> | null = null;
    try {
      saved = await options.loadBounds();
    } catch (error: unknown) {
      logFailure("could not read saved bounds", error);
    }
    if (disposed) throw new Error("Terminal window is unavailable");
    const win = options.create(options.fitBounds(saved ?? DEFAULT_BOUNDS));
    current = win;
    win.on("resize", () => scheduleBoundsSave(win));
    win.on("move", () => scheduleBoundsSave(win));
    win.on("closed", () => {
      if (current !== win) return;
      clearBoundsTimer();
      current = null;
    });
  }

  return {
    current: live,

    /** Opens the window, or focuses it when it already exists. Concurrent calls share one creation. */
    openOrFocus(): Promise<void> {
      if (disposed) return Promise.reject(new Error("Terminal window is unavailable"));
      const existing = live();
      if (existing) {
        focus(existing);
        return Promise.resolve();
      }
      pending ??= open().finally(() => { pending = null; });
      return pending;
    },

    dispose(): void {
      disposed = true;
      clearBoundsTimer();
      const win = live();
      current = null;
      win?.close();
    },
  };
}
