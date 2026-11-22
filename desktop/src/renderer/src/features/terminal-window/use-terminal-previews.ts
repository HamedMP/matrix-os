// The overview's live previews (spec 2706): the last lines on each listed
// terminal's screen, read every few seconds while the overview is open. A
// local or ssh-machine terminal is read from the app's core; a Matrix
// computer's from its gateway. Bounded in how many are read and how much of
// each is kept, and every failure only leaves that preview as it was.
import { useEffect, useMemo, useRef, useState } from "react";
import type { TerminalSidebarRow } from "@matrix-os/ui/terminal-status-sidebar";
import { invoke } from "../../lib/operator";
import type { ApiClient } from "../../lib/api";
import { terminalRowTarget } from "./use-terminal-status";

export const PREVIEW_MAX_TERMINALS = 24;
export const PREVIEW_LINES = 8;
const PREVIEW_LINE_CHARS = 160;
const PREVIEW_INTERVAL_MS = 3_000;
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
  const keys = useMemo(() => rows.slice(0, PREVIEW_MAX_TERMINALS).map((row) => row.key), [rows]);
  const keysRef = useRef(keys);
  const apiRef = useRef(api);
  useEffect(() => { keysRef.current = keys; apiRef.current = api; }, [api, keys]);
  const keySignature = keys.join("\n");

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const round = async () => {
      const shown = keysRef.current;
      const read = await Promise.all(shown.map(async (key) => {
        try {
          const text = await readScreen(key, apiRef.current);
          return [key, text === null ? null : previewLines(text)] as const;
        } catch (error: unknown) {
          console.warn("[terminal-window] preview failed:", error instanceof Error ? error.name : "UnknownError");
          return [key, null] as const;
        }
      }));
      if (cancelled) return;
      setPreviews((current) => {
        // Only terminals still listed are kept, so the map stays as small as the list.
        const next: Record<string, string[]> = {};
        for (const key of shown) if (current[key]) next[key] = current[key]!;
        for (const [key, lines] of read) if (lines) next[key] = lines;
        return next;
      });
      if (!cancelled) timer = setTimeout(() => { void round(); }, PREVIEW_INTERVAL_MS);
    };
    void round();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [enabled, keySignature]);

  return previews;
}
