import { createHash } from "node:crypto";
import type { TerminalRef } from "@matrix-os/contracts";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";

const DEFAULT_MAX_REFS = 1_024;

/** The stable Matrix tab id for a herdr-core terminal: the same on every gateway start. */
export function herdrTabId(herdrId: string): string {
  return `tt_${createHash("sha256").update(`herdr:${herdrId}`).digest("hex").slice(0, 32)}`;
}

export function herdrTerminalRef(herdrId: string): TerminalRef {
  return { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: herdrTabId(herdrId) };
}

/**
 * Matrix tab id -> herdr id for terminals seen recently. Bounded: the least
 * recently seen ids drop out first, and the next listing adds them back.
 */
export function createHerdrRefMap(max = DEFAULT_MAX_REFS) {
  const byTabId = new Map<string, string>();
  return {
    remember(herdrId: string): TerminalRef {
      const ref = herdrTerminalRef(herdrId);
      byTabId.delete(ref.tabId);
      byTabId.set(ref.tabId, herdrId);
      while (byTabId.size > max) {
        const oldest = byTabId.keys().next().value;
        if (oldest === undefined) break;
        byTabId.delete(oldest);
      }
      return ref;
    },
    resolve(ref: TerminalRef): string | undefined {
      if (ref.workspaceId !== HERDR_TERMINAL_WORKSPACE_ID) return undefined;
      return byTabId.get(ref.tabId);
    },
    size: () => byTabId.size,
  };
}
