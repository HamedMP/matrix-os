import { ZellijOutputError } from "./errors.js";

const DEFAULT_BASE_MS = 30_000;
const MAX_DELAY_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 1_024;

/**
 * Workspaces whose restore failed. Each is retried with exponential backoff so
 * one unreadable Zellij session cannot stall the global workspace mutation
 * chain on every sweep. Bounded: the oldest entry is evicted at capacity and
 * is then restored on demand by the next ensureWorkspace for it.
 */
export class WorkspaceRestoreRetries {
  private readonly pending = new Map<string, { failures: number; nextAt: number }>();
  private readonly baseMs: number;
  private readonly maxEntries: number;

  constructor(options: { baseMs?: number; maxEntries?: number } = {}) {
    this.baseMs = Math.max(0, options.baseMs ?? DEFAULT_BASE_MS);
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  recordFailure(workspaceId: string, now: number): void {
    const failures = (this.pending.get(workspaceId)?.failures ?? 0) + 1;
    this.pending.delete(workspaceId);
    if (this.pending.size >= this.maxEntries) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    const delay = Math.min(MAX_DELAY_MS, this.baseMs * 2 ** Math.min(failures - 1, 20));
    this.pending.set(workspaceId, { failures, nextAt: now + delay });
  }

  clear(workspaceId: string): void {
    this.pending.delete(workspaceId);
  }

  due(now: number): string[] {
    return [...this.pending].filter(([, entry]) => entry.nextAt <= now).map(([id]) => id);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Record and log a failed restore; the workspace stays untouched in the store. */
  fail(workspaceId: string, error: unknown, event = "workspace restore failed"): void {
    this.recordFailure(workspaceId, Date.now());
    console.error(`[terminal-runtime] ${event}`, workspaceRestoreFailureFields(workspaceId, error));
  }

  /** Retry every due workspace; the caller runs this on the workspace mutation chain. */
  async retryDue(input: {
    isActive: (workspaceId: string) => Promise<boolean>;
    reconcile: (workspaceId: string) => Promise<void>;
    shuttingDown: () => boolean;
  }): Promise<void> {
    for (const workspaceId of this.due(Date.now())) {
      if (input.shuttingDown()) return;
      if (!await input.isActive(workspaceId)) {
        this.clear(workspaceId);
        continue;
      }
      try {
        await input.reconcile(workspaceId);
        this.clear(workspaceId);
        console.info("[terminal-runtime] workspace restore recovered", { workspaceId });
      } catch (error) {
        this.fail(workspaceId, error, "workspace restore retry failed");
      }
    }
  }
}

/** Log fields for a workspace restore failure: class and code, never raw output. */
export function workspaceRestoreFailureFields(workspaceId: string, error: unknown): Record<string, string> {
  const fields: Record<string, string> = {
    workspaceId,
    error: error instanceof Error ? error.name : "unknown_error",
  };
  if (error instanceof Error && "code" in error && typeof error.code === "string") fields.code = error.code;
  if (error instanceof ZellijOutputError) {
    fields.reason = error.reason;
    fields.output = error.snippet;
  }
  return fields;
}
