interface ReapableSession {
  name: string;
  status?: "active" | "exited";
  updatedAt?: string;
  kind?: string;
}

interface ReaperRegistry {
  list(): Promise<ReapableSession[]>;
  delete(name: string, options?: { force?: boolean }): Promise<void>;
}

export interface ShellSessionReaperOptions {
  registry: ReaperRegistry;
  /** Exited sessions older than this are deleted. Default 7 days. */
  ttlMs?: number;
  /** Sweep cadence. Default 1 hour. */
  intervalMs?: number;
}

/**
 * Periodically deletes exited zellij sessions (and their scrollback, via the
 * registry delete cascade) once they age past the retention TTL.
 *
 * Only sessions carrying `kind` metadata are eligible: entries that predate
 * workspace/kind stamping are pre-upgrade user sessions and must survive
 * until the spec 107 Phase 3 migration has had a chance to convert them.
 */
export function createShellSessionReaper(options: ShellSessionReaperOptions) {
  const ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  let timer: NodeJS.Timeout | null = null;

  async function sweep(): Promise<void> {
    let sessions: ReapableSession[];
    try {
      sessions = await options.registry.list();
    } catch (err: unknown) {
      console.warn("[shell] session reaper list failed:", err instanceof Error ? err.message : String(err));
      return;
    }
    const cutoff = Date.now() - ttlMs;
    for (const session of sessions) {
      if (!session.kind || session.status !== "exited") {
        continue;
      }
      const updatedAt = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
      if (!Number.isFinite(updatedAt) || updatedAt > cutoff) {
        continue;
      }
      try {
        await options.registry.delete(session.name, { force: true });
        console.log("[shell] reaped exited session:", session.name);
      } catch (err: unknown) {
        console.warn("[shell] failed to reap session:", {
          session: session.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  function start(): void {
    if (timer) {
      return;
    }
    timer = setInterval(() => {
      void sweep();
    }, intervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { sweep, start, stop };
}
