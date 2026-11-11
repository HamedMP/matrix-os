import type { TerminalRef } from "@matrix-os/contracts";

const DEFAULT_MAX_TABS = 1_024;
const DEFAULT_TTL_MS = 10 * 60_000;

export interface TerminalInputActivity {
  /** Record that a person typed into this tab through a live viewer. */
  record(ref: TerminalRef): void;
  /** When a person last typed into this tab, if recently. */
  lastInputAt(ref: TerminalRef): number | undefined;
  forget(ref: TerminalRef): void;
}

/**
 * Last human keystroke per terminal tab, so automated sends can wait for a
 * draft instead of splicing into it. Bounded: least recently typed tabs are
 * evicted past `maxTabs`, and entries older than `ttlMs` are dropped on read.
 */
export function createTerminalInputActivity(options: {
  now?: () => number;
  maxTabs?: number;
  ttlMs?: number;
} = {}): TerminalInputActivity {
  const now = options.now ?? Date.now;
  const maxTabs = options.maxTabs ?? DEFAULT_MAX_TABS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const lastInput = new Map<string, number>();
  const key = (ref: TerminalRef) => `${ref.workspaceId}:${ref.tabId}`;

  return {
    record(ref) {
      const id = key(ref);
      lastInput.delete(id);
      lastInput.set(id, now());
      while (lastInput.size > maxTabs) {
        const oldest = lastInput.keys().next().value;
        if (oldest === undefined) break;
        lastInput.delete(oldest);
      }
    },
    lastInputAt(ref) {
      const id = key(ref);
      const at = lastInput.get(id);
      if (at === undefined) return undefined;
      if (now() - at > ttlMs) {
        lastInput.delete(id);
        return undefined;
      }
      return at;
    },
    forget(ref) {
      lastInput.delete(key(ref));
    },
  };
}
