import type { TerminalRef } from "@matrix-os/contracts";
import type { TerminalAgentStatusEntry } from "@matrix-os/terminal-runtime";

const DEFAULT_TTL_MS = 750;

export interface TerminalAgentStatusSource {
  /** Every tab's latest reported status, refreshed at most once per `ttlMs`. */
  list(): Promise<ReadonlyMap<string, TerminalAgentStatusEntry>>;
  get(ref: TerminalRef): Promise<TerminalAgentStatusEntry | undefined>;
  /** When text was last sent into this tab by a terminal verb, if recently. */
  sentAt?(ref: TerminalRef): number | undefined;
  /** Record a send: the next read refreshes, and older reports describe the previous turn. */
  noteSent?(ref: TerminalRef): void;
}

const MAX_SENT_TABS = 1_024;

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
  // Bounded: least recently sent tabs drop out past MAX_SENT_TABS.
  const sent = new Map<string, number>();

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
    sentAt(ref) {
      return sent.get(terminalRefKey(ref));
    },
    noteSent(ref) {
      const key = terminalRefKey(ref);
      sent.delete(key);
      sent.set(key, now());
      while (sent.size > MAX_SENT_TABS) {
        const oldest = sent.keys().next().value;
        if (oldest === undefined) break;
        sent.delete(oldest);
      }
      cached = null;
    },
  };
}

/**
 * Whether a status report predates the latest send, and so belongs to the
 * previous turn. Reports carry milliseconds. A whole-second report from an older
 * reporter in the send's second also counts as the previous turn: the wait may
 * hold for the grace period, but never ends on the previous task's result.
 */
export function reportPredatesSend(entry: Pick<TerminalAgentStatusEntry, "reportedAt">, sentAt: number): boolean {
  return Date.parse(entry.reportedAt) < sentAt;
}
