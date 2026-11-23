// The overview's live previews (spec 2706): the last lines on each listed
// terminal's screen while the overview is open. A local or ssh-machine
// terminal is read from the app's core every few seconds. A Matrix computer's
// is read from its gateway, which asks Zellij for the screen and makes it
// repaint, so it is read once and again only after its status changed (at
// most every 15 s), or 15 s after a read that failed; an idle one is left alone,
// also when other terminals join or leave the list. Nothing is read while the
// window is hidden. Bounded in how many are read and how much of each is
// kept, and every failure only leaves that preview as it was.
import { useEffect, useMemo, useRef, useState } from "react";
import type { TerminalSidebarRow } from "@matrix-os/ui/terminal-status-sidebar";
import { invoke } from "../../lib/operator";
import type { ApiClient } from "../../lib/api";
import { terminalRowTarget } from "./use-terminal-status";

export const PREVIEW_MAX_TERMINALS = 24;
export const PREVIEW_LINES = 8;
const PREVIEW_LINE_CHARS = 160;
const PREVIEW_INTERVAL_MS = 3_000;
/** A Matrix computer's terminal is read again no sooner than this, and only after its status changed. */
export const COMPUTER_PREVIEW_MIN_MS = 15_000;
const PREVIEW_TIMEOUT_MS = 5_000;
const PREVIEW_MAX_BYTES = 64 * 1024;

/** A screen's last lines that hold something, each cut to a preview's width. */
export function previewLines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/\s+$/, "")).filter((line) => line.length > 0)
    .slice(-PREVIEW_LINES).map((line) => line.slice(0, PREVIEW_LINE_CHARS));
}

async function readScreen(key: string, api: (slot: string) => ApiClient | null): Promise<string | null> {
  const target = terminalRowTarget(key);
  if (!target) return null;
  if (target.kind === "local") {
    const result = await invoke("local-terminal:read", { id: target.id });
    return result.ok ? result.text : null;
  }
  const client = api(target.slot);
  if (!client) return null;
  const path = `/api/terminal/workspaces/${encodeURIComponent(target.ref.workspaceId)}/tabs/${encodeURIComponent(target.ref.tabId)}/read?lines=0`;
  const result = await client.get<{ screen?: unknown }>(path, { timeoutMs: PREVIEW_TIMEOUT_MS, maxBytes: PREVIEW_MAX_BYTES });
  return typeof result.screen === "string" ? result.screen : null;
}

export function useTerminalPreviews(options: {
  rows: readonly TerminalSidebarRow[];
  enabled: boolean;
  api(slot: string): ApiClient | null;
}): Readonly<Record<string, string[]>> {
  const { rows, enabled, api } = options;
  const [previews, setPreviews] = useState<Record<string, string[]>>({});
  const shownRows = useMemo(() => rows.slice(0, PREVIEW_MAX_TERMINALS), [rows]);
  const keys = useMemo(() => shownRows.map((row) => row.key), [shownRows]);
  const rowsRef = useRef(shownRows);
  const apiRef = useRef(api);
  useEffect(() => { rowsRef.current = shownRows; apiRef.current = api; }, [api, shownRows]);
  const keySignature = keys.join("\n");
  // When each computer terminal was last read, the status it had then, and whether the read worked.
  // Kept while the overview stays open, across changes to the list; bounded by the list.
  const lastReadRef = useRef(new Map<string, { at: number; statusAt: string | undefined; ok: boolean }>());

  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup, react-doctor/no-set-state-after-await-in-effect -- the round's timer is cleared and the loop cancelled in the returned cleanup (nothing starts while disabled); a late read still lands for terminals listed now, so an idle one is not left blank
  useEffect(() => {
    const lastRead = lastReadRef.current;
    if (!enabled) { lastRead.clear(); return undefined; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const due = (row: TerminalSidebarRow, now: number) => {
      if (terminalRowTarget(row.key)?.kind !== "computer") return true;
      const last = lastRead.get(row.key);
      if (!last) return true;
      if (now - last.at < COMPUTER_PREVIEW_MIN_MS) return false;
      // A failed read is tried again; a read one only once its status changed.
      return !last.ok || last.statusAt !== row.statusAt;
    };
    const round = async () => {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(() => { void round(); }, PREVIEW_INTERVAL_MS);
        return;
      }
      const now = Date.now();
      const listed = rowsRef.current;
      const shown = listed.map((row) => row.key);
      const listedKeys = new Set(shown);
      for (const key of [...lastRead.keys()]) if (!listedKeys.has(key)) lastRead.delete(key);
      const reading = listed.filter((row) => due(row, now));
      for (const row of reading) if (terminalRowTarget(row.key)?.kind === "computer") lastRead.set(row.key, { at: now, statusAt: row.statusAt, ok: true });
      const read = await Promise.all(reading.map(async ({ key }) => {
        let lines: string[] | null = null;
        try {
          const text = await readScreen(key, apiRef.current);
          lines = text === null ? null : previewLines(text);
        } catch (error: unknown) {
          console.warn("[terminal-window] preview failed:", error instanceof Error ? error.name : "UnknownError");
        }
        const last = lastRead.get(key);
        if (lines === null && last?.at === now) lastRead.set(key, { ...last, ok: false });
        return [key, lines] as const;
      }));
      // A read that finished after the list changed still counts for terminals listed now: its
      // terminal is not read again until its status changes, so its result must not be dropped.
      const stillListed = new Set(rowsRef.current.map((row) => row.key));
      setPreviews((current) => {
        // Only terminals still listed are kept, so the map stays as small as the list.
        const next: Record<string, string[]> = {};
        for (const key of stillListed) if (current[key]) next[key] = current[key]!;
        for (const [key, lines] of read) if (lines && stillListed.has(key)) next[key] = lines;
        return next;
      });
      if (cancelled) return;
      if (!cancelled) timer = setTimeout(() => { void round(); }, PREVIEW_INTERVAL_MS);
    };
    void round();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [enabled, keySignature]);

  return previews;
}
