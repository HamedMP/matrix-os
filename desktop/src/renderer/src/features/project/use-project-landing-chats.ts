import { useEffect, useMemo, useState } from "react";
import { useBotConversationSummaries, mergeCanonicalChatRecord, compareCanonicalChatActivity } from "@matrix-os/ui";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { CanonicalChatClient, CanonicalChatEventSource } from "../../lib/canonical-chat-client";
import { useUi } from "../../stores/ui";
import type { Project } from "../../stores/board";
import { loadWorkRailChats } from "../work/work-rail-data";

/** Retain the same authority's loaded cards during background refreshes. */
export function useProjectLandingChats(project: Project, client?: CanonicalChatClient | null, eventSource?: Pick<CanonicalChatEventSource, "subscribe">, active = true) {
  const refreshRequest = useUi(state => state.projectChatMoveRefreshRequest);
  const [snapshot, setSnapshot] = useState<{client: CanonicalChatClient; records: CanonicalChatRecord[]; error: boolean} | null>(null);
  useEffect(() => {
    if (!client || !active) return;
    let current = true;
    let pending = false;
    let again = false;
    const refresh = async () => {
      if (pending) { again = true; return; }
      pending = true;
      do {
        again = false;
        try {
          // Query the Project rather than the newest global page, retaining
          // both persisted stable-ID and older slug associations.
          const references = [...new Set([project.id,project.slug].filter((value): value is string => Boolean(value)))];
          const pages = await Promise.all(references.map(reference => loadWorkRailChats(client,false,reference)));
          const unique = new Map<string,CanonicalChatRecord>();
          for (const record of pages.flat()) unique.set(record.chat.id,record);
          const loaded = [...unique.values()].sort(compareCanonicalChatActivity).slice(0,1000);
          if (!current) return;
          setSnapshot(previous => ({client, error:false, records:loaded.map(record => {
            const known = previous?.client === client ? previous.records.find(item => item.chat.id === record.chat.id) : undefined;
            return known ? mergeCanonicalChatRecord(known, record) : record;
          })}));
        } catch (error: unknown) {
          console.warn("[project] Chat cards unavailable:", error instanceof Error ? error.name : "UnknownError");
          if (current) setSnapshot(previous => ({client, records:previous?.client === client ? previous.records : [], error:true}));
        }
      } while (current && again);
      pending = false;
    };
    void refresh();
    const subscription = eventSource?.subscribe(event => {
      if (event.type === "chat.changed" && event.eventType === "run.message") return;
      void refresh();
    });
    return () => { current = false; subscription?.dispose(); };
  }, [client, active, eventSource, project.id, project.slug, refreshRequest]);
  const records = useMemo(() => snapshot && snapshot.client === client ? snapshot.records : [], [snapshot,client]);
  const ids = useMemo(() => records.map(record => record.chat.id), [records]);
  const bots = useBotConversationSummaries(client?.agents, ids, active);
  const chats = useMemo(() => records.filter(record => (
    (record.projectId === project.id || record.projectId === project.slug)
    && !bots.unresolvedChatIds.includes(record.chat.id)
    && !bots.conversations.some(bot => bot.chatId === record.chat.id)
  )), [records, project.id, project.slug, bots.unresolvedChatIds, bots.conversations]);
  return {chats, error:Boolean(snapshot && snapshot.client === client && snapshot.error)};
}
