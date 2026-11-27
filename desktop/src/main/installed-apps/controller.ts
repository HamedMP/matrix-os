// Owns installed-app windows: one per installId, single-flight creation,
// focus when already open, a cap on open windows, and debounced per-install
// window-state persistence. Electron specifics are injected (see the Terminal
// window controller) so this stays unit-testable.
import type { FittedWindowBounds, WindowBounds } from "../platform/window-bounds";
import { InstallIdSchema, type InstalledAppRecord } from "./record";

export interface InstalledAppWindowLike {
  on(event: "resize" | "move" | "close" | "closed", listener: () => void): unknown;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  close(): void;
  getBounds(): { x: number; y: number; width: number; height: number };
}

export type InstalledAppOpenResult = "opened" | "focused" | "not-installed" | "limit" | "unavailable";

/** A macOS app shim the window is created in; it cannot change after creation. */
export interface InstalledAppOpenContext { appShim?: unknown }

export interface InstalledAppWindowControllerOptions<W extends InstalledAppWindowLike> {
  getRecord(installId: string): Promise<InstalledAppRecord | null>;
  create(record: InstalledAppRecord, bounds: FittedWindowBounds, context: InstalledAppOpenContext): W;
  loadBounds(installId: string): Promise<Required<WindowBounds> | null>;
  saveBounds(installId: string, bounds: Required<WindowBounds>): Promise<void>;
  fitBounds(bounds: WindowBounds): FittedWindowBounds;
  maxWindows?: number;
}

export const MAX_INSTALLED_APP_WINDOWS = 16;
const DEFAULT_BOUNDS: WindowBounds = { width: 1000, height: 720 };
const STATE_SAVE_DELAY_MS = 500;

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

export function createInstalledAppWindowController<W extends InstalledAppWindowLike>(
  options: InstalledAppWindowControllerOptions<W>,
) {
  const maxWindows = Math.max(1, Math.min(options.maxWindows ?? MAX_INSTALLED_APP_WINDOWS, MAX_INSTALLED_APP_WINDOWS));
  // These maps are bounded by maxWindows: entries are admitted only below the cap.
  const open = new Map<string, W>();
  const shims = new Map<string, unknown>();
  const pending = new Map<string, Promise<InstalledAppOpenResult>>();
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const saves = new Set<Promise<void>>();
  let disposed = false;

  const live = (installId: string): W | null => {
    const win = open.get(installId);
    return win && !win.isDestroyed() ? win : null;
  };

  const focus = (win: W) => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const save = (installId: string, win: W) => {
    const { x, y, width, height } = win.getBounds();
    const write = options.saveBounds(installId, { x, y, width, height })
      .catch((error: unknown) => logFailure("could not persist window state", error))
      .finally(() => { saves.delete(write); });
    saves.add(write);
  };

  const clearTimer = (installId: string) => {
    const timer = saveTimers.get(installId);
    if (timer) clearTimeout(timer);
    saveTimers.delete(installId);
  };

  const scheduleSave = (installId: string, win: W) => {
    clearTimer(installId);
    saveTimers.set(installId, setTimeout(() => {
      saveTimers.delete(installId);
      if (win.isDestroyed() || open.get(installId) !== win) return;
      save(installId, win);
    }, STATE_SAVE_DELAY_MS));
  };

  /** Takes a window out of the controller (its state saved now), then closes it. */
  const retire = (installId: string, win: W) => {
    clearTimer(installId);
    save(installId, win);
    open.delete(installId);
    shims.delete(installId);
    win.close();
  };

  async function create(installId: string, context: InstalledAppOpenContext): Promise<InstalledAppOpenResult> {
    let record: InstalledAppRecord | null;
    try {
      record = await options.getRecord(installId);
    } catch (error: unknown) {
      logFailure("could not read install record", error);
      return "unavailable";
    }
    if (!record) return "not-installed";
    let saved: Required<WindowBounds> | null = null;
    try {
      saved = await options.loadBounds(installId);
    } catch (error: unknown) {
      logFailure("could not read window state", error);
    }
    if (disposed) return "unavailable";
    // A plain window opened meanwhile (deep link) is replaced by the shim's.
    const previous = live(installId);
    if (previous && context.appShim !== undefined) retire(installId, previous);
    let win: W;
    try {
      win = options.create(record, options.fitBounds(saved ?? DEFAULT_BOUNDS), context);
    } catch (error: unknown) {
      logFailure("could not create app window", error);
      return "unavailable";
    }
    open.set(installId, win);
    if (context.appShim === undefined) shims.delete(installId);
    else shims.set(installId, context.appShim);
    win.on("resize", () => scheduleSave(installId, win));
    win.on("move", () => scheduleSave(installId, win));
    // Bounds are still readable on "close": save once, replacing any debounced save.
    win.on("close", () => {
      if (open.get(installId) !== win) return;
      clearTimer(installId);
      save(installId, win);
    });
    win.on("closed", () => {
      if (open.get(installId) !== win) return;
      clearTimer(installId);
      open.delete(installId);
      shims.delete(installId);
    });
    return "opened";
  }

  function closeEach(installIds: Iterable<string>): void {
    for (const installId of [...installIds]) live(installId)?.close();
  }

  return {
    current: live,

    openCount(): number {
      let count = 0;
      for (const installId of open.keys()) if (live(installId)) count += 1;
      return count;
    },

    installIds(): string[] {
      return [...open.keys()].filter((installId) => live(installId));
    },

    /** The app shim of the install's open window, if it has one. */
    shimOf(installId: string): unknown {
      return live(installId) ? shims.get(installId) : undefined;
    },

    /**
     * Opens the install's window, or focuses it. Concurrent calls for one
     * install share a creation. With `appShim`, a window outside that shim is
     * replaced by one inside it; a plain open focuses a shim's window.
     */
    openOrFocus(installId: string, context: InstalledAppOpenContext = {}): Promise<InstalledAppOpenResult> {
      if (disposed) return Promise.resolve("unavailable");
      if (!InstallIdSchema.safeParse(installId).success) return Promise.resolve("not-installed");
      const existing = live(installId);
      const inPlace = context.appShim === undefined || shims.get(installId) === context.appShim;
      if (existing && inPlace) {
        focus(existing);
        return Promise.resolve("focused");
      }
      const inFlight = pending.get(installId);
      if (inFlight) return context.appShim === undefined ? inFlight : inFlight.then(() => this.openOrFocus(installId, context));
      if (!existing && this.openCount() + pending.size >= maxWindows) return Promise.resolve("limit");
      const creation = create(installId, context).finally(() => { pending.delete(installId); });
      pending.set(installId, creation);
      return creation;
    },

    /** Writes the window's current state now, replacing any debounced save. */
    saveNow(installId: string): void {
      const win = live(installId);
      if (!win) return;
      clearTimer(installId);
      save(installId, win);
    },

    closeWhere(select: (installId: string, win: W) => boolean): void {
      closeEach(this.installIds().filter((installId) => select(installId, open.get(installId)!)));
    },

    /** Closes every window and resolves once their window state is written. */
    async closeAll(): Promise<void> {
      closeEach(open.keys());
      await Promise.all([...saves]);
    },

    /** Quit: no further opens; close windows and flush their state. */
    async dispose(): Promise<void> {
      disposed = true;
      await this.closeAll();
    },
  };
}
