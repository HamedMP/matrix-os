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
  const loadedKey = useRef<string | null>(null);

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
        loadedKey.current = key;
        setState({ key, error: false, records: [...unique.values()].sort(compareCanonicalChatActivity).slice(0, MAX_PROJECT_HISTORY_ROWS) });
      } catch (error: unknown) {
        console.warn("[web-projects] project history unavailable", error instanceof Error ? error.name : "UnknownError");
        if (current) setState((previous) => ({ key, error: true, records: previous?.key === key ? previous.records : [] }));
      }
    };
    // The first read for a Project starts at once; refreshes after Chat changes coalesce.
    const timer = window.setTimeout(() => { void load(); }, loadedKey.current === key ? PROJECT_HISTORY_REFRESH_DELAY_MS : 0);
    return () => { current = false; window.clearTimeout(timer); };
  }, [enabled, gatewayUrl, key, project.id, project.slug, refreshKey, retryCount]);

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
