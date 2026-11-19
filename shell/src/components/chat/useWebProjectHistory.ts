"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { compareCanonicalChatActivity, useBotConversationSummaries, type ChatAgentClient, type ChatNavigationRecord } from "@matrix-os/ui";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { createCanonicalShellChatClient } from "@/lib/canonical-chat-client";
import type { WebProject } from "./web-projects";

// Matches the global navigation window; each reference pages at most this far.
export const MAX_PROJECT_HISTORY_ROWS = 1_000;
const MAX_PROJECT_HISTORY_PAGES = 10;
// A burst of Chat changes reads the history once, not once per event.
export const PROJECT_HISTORY_REFRESH_DELAY_MS = 500;

/**
 * Runs `task` on request, never two at once and at most once per `intervalMs`.
 * Requests while it runs queue one trailing run; requests while one is already
 * scheduled change nothing, so a steady stream cannot postpone it.
 */
export function createSingleFlightThrottle(task: () => Promise<void>, intervalMs: number) {
  let disposed = false;
  let inFlight = false;
  let trailing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastStart = Number.NEGATIVE_INFINITY;
  const run = async () => {
    timer = undefined;
    inFlight = true;
    lastStart = Date.now();
    try { await task(); } finally { inFlight = false; }
    if (!disposed && trailing) { trailing = false; request(); }
  };
  const request = () => {
    if (disposed) return;
    if (inFlight) { trailing = true; return; }
    if (timer !== undefined) return;
    timer = setTimeout(() => { void run(); }, Math.max(0, lastStart + intervalMs - Date.now()));
  };
  return {
    request,
    dispose: () => { disposed = true; trailing = false; clearTimeout(timer); timer = undefined; },
  };
}

type HistoryState = { key: string; records: CanonicalChatRecord[]; error: boolean };

/**
 * A bounded global window cannot prove that an older Project has no Chats, so
 * when it is cut off the Project's own history is read, as Electron Desktop
 * does, and read again after every Chat change. Any Chat the shared list knows
 * (in this Project, another one, or deleted) keeps the shared list's answer;
 * history-only rows are kept only once they are known not to be Bot Chats.
 */
export function useWebProjectHistory({ project, gatewayUrl, listed, knownChatIds, refreshKey = 0, enabled, botClient }: {
  project: WebProject;
  gatewayUrl: string;
  /** This Project's ordinary Chats from the shared navigation projection. */
  listed: readonly ChatNavigationRecord[];
  /** Every Chat the shared list knows or deleted, whichever Project holds it. */
  knownChatIds?: ReadonlySet<string>;
  /** Changes whenever a Chat changes, so cached history is read again. */
  refreshKey?: number;
  enabled: boolean;
  botClient?: ChatAgentClient;
}) {
  const key = JSON.stringify([gatewayUrl, project.id, project.slug]);
  const [state, setState] = useState<HistoryState | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  // The current authority's read scheduler; refresh requests go through it.
  const requestRead = useRef<(() => void) | null>(null);

  // One scheduler per Project and computer. A read in flight always finishes,
  // changes during it queue a single trailing read, and reads start at most
  // once per PROJECT_HISTORY_REFRESH_DELAY_MS however often Chats change.
  // Only a new Project or computer (this effect's cleanup) cancels a read.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the routed owner's computer is only known at runtime.
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const client = createCanonicalShellChatClient({ gatewayUrl });
    const references = [...new Set([project.id, project.slug].filter(Boolean))];
    const load = async () => {
      try {
        // react-doctor-disable-next-line react-doctor/async-defer-await -- `current` is cleared by the effect cleanup during this await, so it can only be checked afterwards.
        const pages = await Promise.all(references.map(async (projectId) => {
          const records: CanonicalChatRecord[] = [];
          const seen = new Set<string>(); // at most MAX_PROJECT_HISTORY_PAGES cursors
          let cursor: string | undefined;
          for (let page = 0; page < MAX_PROJECT_HISTORY_PAGES && records.length < MAX_PROJECT_HISTORY_ROWS; page += 1) {
            // react-doctor-disable-next-line react-doctor/async-defer-await -- `current` is cleared by the effect cleanup during this await, so it can only be checked afterwards.
            const response = await client.list({ projectId, ...(cursor ? { cursor } : {}) });
            if (!current) break; // superseded: stop paging for an old project or computer
            records.push(...response.items);
            if (!response.nextCursor || seen.has(response.nextCursor)) break;
            cursor = response.nextCursor;
            seen.add(cursor);
          }
          return records;
        }));
        if (!current) return;
        const unique = new Map<string, CanonicalChatRecord>(); // at most two bounded pages of rows
        for (const record of pages.flat()) unique.set(record.chat.id, record);
        setState({ key, error: false, records: [...unique.values()].sort(compareCanonicalChatActivity).slice(0, MAX_PROJECT_HISTORY_ROWS) });
      } catch (error: unknown) {
        console.warn("[web-projects] project history unavailable", error instanceof Error ? error.name : "UnknownError");
        if (current) setState((previous) => ({ key, error: true, records: previous?.key === key ? previous.records : [] }));
      }
    };
    const reads = createSingleFlightThrottle(load, PROJECT_HISTORY_REFRESH_DELAY_MS);
    requestRead.current = reads.request;
    reads.request();
    return () => {
      current = false;
      if (requestRead.current === reads.request) requestRead.current = null;
      reads.dispose();
    };
  }, [enabled, gatewayUrl, key, project.id, project.slug]);

  // Chat changes and Try again ask the scheduler; the first render's request is the initial read.
  const firstRequest = useRef(true);
  useEffect(() => {
    if (firstRequest.current) { firstRequest.current = false; return; }
    requestRead.current?.();
  }, [refreshKey, retryCount]);

  const history = useMemo(() => (enabled && state?.key === key ? state.records : []), [enabled, key, state]);
  const listedIds = useMemo(() => new Set([...listed.map((record) => record.chat.id), ...(knownChatIds ?? [])]), [listed, knownChatIds]);
  const historyOnlyIds = useMemo(() => history.flatMap((record) => listedIds.has(record.chat.id) ? [] : [record.chat.id]), [history, listedIds]);
  const bots = useBotConversationSummaries(botClient, historyOnlyIds, enabled && historyOnlyIds.length > 0);
  const records = useMemo<ChatNavigationRecord[]>(() => {
    if (!enabled) return [...listed];
    const unresolved = new Set([...bots.unresolvedChatIds, ...bots.conversations.map((bot) => bot.chatId)]);
    const extra = botClient ? history.filter((record) => !listedIds.has(record.chat.id) && !unresolved.has(record.chat.id)) : [];
    return [...listed, ...extra].sort(compareCanonicalChatActivity).slice(0, MAX_PROJECT_HISTORY_ROWS);
  }, [enabled, listed, history, listedIds, botClient, bots.unresolvedChatIds, bots.conversations]);

  const loaded = !enabled || state?.key === key;
  return {
    records,
    loading: !loaded,
    error: enabled && state?.key === key && state.error,
    capped: history.length >= MAX_PROJECT_HISTORY_ROWS,
    retry: () => setRetryCount((count) => count + 1),
  };
}
