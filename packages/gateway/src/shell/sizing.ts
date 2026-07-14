export type ShellClientClass = "hard" | "soft" | "legacy";

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface SessionSizingOptions {
  /** Last persisted canonical size, if any. */
  initialSize?: TerminalSize | null;
  /** Fallback when nothing is persisted and no hard client is attached. */
  defaultSize?: TerminalSize;
  debounceMs?: number;
  /** Apply the canonical size to every attached pty. */
  onApply: (size: TerminalSize) => void;
  /** Persist the canonical size (registry). */
  persist?: (size: TerminalSize) => void;
}

const MIN_COLS = 1;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 200;

export function clampTerminalSize(size: TerminalSize): TerminalSize {
  return {
    cols: Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(size.cols) || MIN_COLS)),
    rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(size.rows) || MIN_ROWS)),
  };
}

/**
 * Canonical session size arbiter (spec 107 FR-006..009).
 *
 * Hard clients (CLI/TTY — cannot scale their render) negotiate the canonical
 * size as the component-wise minimum of their declared sizes. Soft clients
 * (web, native mobile — render the canonical grid scaled) never influence it.
 * Legacy clients (no class declared) keep today's resize-follow behavior, but
 * only while zero classified clients are attached, so an un-upgraded client
 * can never shrink a session an upgraded client is using.
 */
export function createSessionSizing(options: SessionSizingOptions) {
  const debounceMs = options.debounceMs ?? 500;
  const defaultSize = clampTerminalSize(options.defaultSize ?? { cols: 200, rows: 50 });
  let persistedSize: TerminalSize | null = options.initialSize ? clampTerminalSize(options.initialSize) : null;
  const clients = new Map<string, { klass: ShellClientClass; declared: TerminalSize | null }>();
  let applied: TerminalSize | null = null;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  function classifiedCount(): number {
    let count = 0;
    for (const client of clients.values()) {
      if (client.klass !== "legacy") {
        count += 1;
      }
    }
    return count;
  }

  function computeCanonical(): TerminalSize {
    let cols = Number.POSITIVE_INFINITY;
    let rows = Number.POSITIVE_INFINITY;
    let hardSeen = false;
    for (const client of clients.values()) {
      if (client.klass !== "hard" || !client.declared) {
        continue;
      }
      hardSeen = true;
      cols = Math.min(cols, client.declared.cols);
      rows = Math.min(rows, client.declared.rows);
    }
    if (!hardSeen) {
      return persistedSize ?? defaultSize;
    }
    return clampTerminalSize({ cols, rows });
  }

  function scheduleApply(): void {
    // Always cancel first: a timer armed while classified clients existed
    // must not fire after the last one detached and persist a stale fallback.
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (disposed || classifiedCount() === 0) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (disposed || classifiedCount() === 0) {
        return;
      }
      const next = computeCanonical();
      if (applied && applied.cols === next.cols && applied.rows === next.rows) {
        return;
      }
      applied = next;
      persistedSize = next;
      options.onApply(next);
      options.persist?.(next);
    }, debounceMs);
    timer.unref?.();
  }

  return {
    attach(id: string, klass: ShellClientClass, declared: TerminalSize | null): void {
      clients.set(id, { klass, declared: declared ? clampTerminalSize(declared) : null });
      scheduleApply();
    },
    detach(id: string): void {
      if (clients.delete(id)) {
        scheduleApply();
      }
    },
    /** A hard client's declared size changed (its terminal was resized). */
    declared(id: string, size: TerminalSize): void {
      const client = clients.get(id);
      if (!client) {
        return;
      }
      client.declared = clampTerminalSize(size);
      if (client.klass === "hard") {
        scheduleApply();
      }
    },
    /** True while legacy resize frames may drive the pty (no classified clients). */
    legacyResizeAllowed(): boolean {
      return classifiedCount() === 0;
    },
    current(): TerminalSize | null {
      if (classifiedCount() === 0) {
        return persistedSize ?? null;
      }
      return computeCanonical();
    },
    /** Size to spawn a new attach pty at. */
    spawnSize(): TerminalSize {
      if (classifiedCount() === 0) {
        return persistedSize ?? defaultSize;
      }
      return computeCanonical();
    },
    dispose(): void {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export type SessionSizing = ReturnType<typeof createSessionSizing>;
