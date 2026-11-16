import type { TerminalRef } from "@matrix-os/contracts";
import type { TerminalAgentStatusEntry } from "@matrix-os/terminal-runtime";

const DEFAULT_TTL_MS = 750;

export interface TerminalAgentStatusSource {
  /** Every tab's latest reported status, refreshed at most once per `ttlMs`. */
  list(): Promise<ReadonlyMap<string, TerminalAgentStatusEntry>>;
  get(ref: TerminalRef): Promise<TerminalAgentStatusEntry | undefined>;
}

export function terminalRefKey(ref: TerminalRef): string {
  return `${ref.workspaceId}:${ref.tabId}`;
}

/**
 * Shared, short-lived cache over the terminal runtime's per-tab status index, so
 * many waiters and event subscribers cost one socket call per refresh. A
 * runtime that predates the status operation reports no statuses.
 */
export function createTerminalAgentStatusSource(options: {
  runtime: { listAgentStatuses?(): Promise<TerminalAgentStatusEntry[]> };
  now?: () => number;
  ttlMs?: number;
}): TerminalAgentStatusSource {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  let cached: { at: number; value: ReadonlyMap<string, TerminalAgentStatusEntry> } | null = null;
  let inFlight: Promise<ReadonlyMap<string, TerminalAgentStatusEntry>> | null = null;
  let warned = false;

  async function load(): Promise<ReadonlyMap<string, TerminalAgentStatusEntry>> {
    if (!options.runtime.listAgentStatuses) return new Map();
    try {
      const entries = await options.runtime.listAgentStatuses();
      warned = false;
      return new Map(entries.map((entry) => [terminalRefKey(entry.ref), entry]));
    } catch (error: unknown) {
      // Status is advisory: an older or restarting runtime must not fail verbs.
      if (!warned) console.warn("[gateway] terminal agent status unavailable", error instanceof Error ? error.name : "unknown_error");
      warned = true;
      return cached?.value ?? new Map();
    }
  }

  async function list() {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    inFlight ??= load().then((value) => {
      cached = { at: now(), value };
      return value;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    list,
    async get(ref) {
      return (await list()).get(terminalRefKey(ref));
    },
  };
}
