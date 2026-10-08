"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatNavigationAuthorityRevoked, legacyChatNavigation, mergeChatNavigationRecord, type ChatNavigationRecord } from "@matrix-os/ui";
import type { CanonicalChatNavigationItem, CanonicalChatRecord } from "@matrix-os/contracts";
import { CanonicalShellChatRequestError, type CanonicalShellChatClient } from "@/lib/canonical-chat-client";
import type { useShellChatNavigation } from "./useChatNavigation";

type Navigation = ReturnType<typeof useShellChatNavigation>;
type Update = (items: ChatNavigationRecord[]) => ChatNavigationRecord[];
const EMPTY: CanonicalChatNavigationItem[] = [];

/** A truncated global window cannot prove that older unread Chats do not exist. */
export function useUnreadChatNavigation(client: CanonicalShellChatClient, navigation: Navigation, unreadOnly: boolean) {
  const scope = navigation.store;
  const scoped = unreadOnly && navigation.truncated && Boolean(scope);
  // Legacy identity caches must not outlive the verified navigation authority.
  const agents = useMemo(() => scope && client.agents ? { ...client.agents } : undefined, [client, scope]);
  const [snapshot, setSnapshot] = useState<{
    client: CanonicalShellChatClient;
    scope: typeof scope;
    items: CanonicalChatNavigationItem[];
    error: string | null;
  } | null>(null);
  const requestFence = useRef(0);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => {
    requestFence.current++;
    setRevision(value => value + 1);
  }, []);

  useEffect(() => {
    if (!scoped) return;
    let current = true;
    const fence = ++requestFence.current;
    const isCurrent = () => current && fence === requestFence.current;
    void (async () => {
      try {
        const records: CanonicalChatRecord[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>(); // at most ten page cursors per request
        for (let pageIndex = 0; pageIndex < 10 && records.length < 1000; pageIndex++) {
          const page = await client.list({ unreadOnly: true, ...(cursor ? { cursor } : {}) });
          if (!isCurrent()) return;
          records.push(...page.items.slice(0, 1000 - records.length));
          if (!page.nextCursor || seen.has(page.nextCursor)) break;
          cursor = page.nextCursor;
          seen.add(cursor);
        }
        // Publish only after all bounded pages and authenticated classifications settle.
        const unique = [...new Map(records.map(record => [record.chat.id, record])).values()]; // at most 1,000 rows
        const classified = await legacyChatNavigation(unique, agents);
        if (isCurrent()) setSnapshot({ client, scope, items: classified.items, error: null });
      } catch (error: unknown) {
        console.warn("[chat-navigation] Unread history unavailable:", error instanceof Error ? error.name : "UnknownError");
        if (!isCurrent()) return;
        const revoked = error instanceof ChatNavigationAuthorityRevoked
          || (error instanceof CanonicalShellChatRequestError && (error.status === 401 || error.status === 403));
        if (revoked) scope?.dispose(true);
        setSnapshot(previous => ({ client, scope,
          items: !revoked && previous?.client === client && previous.scope === scope ? previous.items : [],
          error: "Unread Chats could not be refreshed. Try again.",
        }));
      }
    })();
    return () => { current = false; };
  }, [client, agents, scope, scoped, navigation.items, revision]);

  const visible = scoped && snapshot?.client === client && snapshot.scope === scope ? snapshot : null;
  const items = scoped ? visible?.items ?? EMPTY : navigation.items;
  const records = useMemo(() => items.filter(item => !unreadOnly || item.readState.unread), [items, unreadOnly]);
  const update = useCallback((apply: Update) => {
    if (scoped) refresh();
    setSnapshot(previous => {
      if (!previous || previous.client !== client || previous.scope !== scope) return previous;
      return { ...previous, items: apply(previous.items).flatMap(record => {
        const known = previous.items.find(item => item.chat.id === record.chat.id);
        return known ? [mergeChatNavigationRecord(known, record)] : [];
      }) };
    });
  }, [client, scope, scoped, refresh]);
  return { records, items, error: scoped ? visible?.error ?? null : null, update, refresh };
}
