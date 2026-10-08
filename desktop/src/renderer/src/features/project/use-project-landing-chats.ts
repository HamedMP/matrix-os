import { useEffect, useMemo, useState } from "react";
import { useBotConversationSummaries, mergeCanonicalChatRecord, compareCanonicalChatActivity, type ChatNavigationRecord } from "@matrix-os/ui";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { CanonicalChatClient, CanonicalChatEventSource } from "../../lib/canonical-chat-client";
import { AppError } from "../../../../shared/app-error";
import { useUi } from "../../stores/ui";
import type { Project } from "../../stores/board";
import { loadWorkRailChats } from "../work/work-rail-data";
import { useWorkNavigation } from "../work/use-work-navigation";

/** Project selection filters the shared owner/runtime snapshot without reloading it. */
export function useProjectLandingChats(project: Project, client?: CanonicalChatClient | null, eventSource?: Pick<CanonicalChatEventSource, "subscribe">, active = true) {
  const navigation = useWorkNavigation(client ?? null, eventSource, active);
  const refreshRequest = useUi(state => state.projectChatMoveRefreshRequest);
  // A bounded global window cannot establish that an older Project has no Chats.
  // Only that case needs the existing scoped history and binding reads.
  const scoped = Boolean(client && navigation.store && navigation.truncated);
  const scope = navigation.store;
  const authorityEpoch = scope?.getAuthorityEpoch() ?? 0;
  const botAuthority = useMemo(() => ({
    epoch: authorityEpoch,
    client: scope && client?.agents ? { ...client.agents } : undefined,
  }), [client, scope, authorityEpoch]);
  const projectKey = JSON.stringify([project.id, project.slug]);
  const [snapshot, setSnapshot] = useState<{
    client: CanonicalChatClient;
    scope: typeof scope;
    authorityEpoch: number;
    projectKey: string;
    records: CanonicalChatRecord[];
    error: boolean;
  } | null>(null);
  useEffect(() => {
    // A same-store revocation must also discard retained cards and identity data.
    setSnapshot(previous => previous && previous.client === client && previous.scope === scope
      && previous.authorityEpoch === authorityEpoch && previous.projectKey === projectKey ? previous : null);
  }, [client, scope, authorityEpoch, projectKey]);
  useEffect(() => {
    if (!client || !active || !scoped) return;
    let current = true;
    const isCurrent = () => current && scope?.getAuthorityEpoch() === authorityEpoch;
    let pending = false;
    let again = false;
    const refresh = async () => {
      if (!isCurrent()) return;
      if (pending) { again = true; return; }
      pending = true;
      do {
        again = false;
        try {
          const references = [...new Set([project.id, project.slug].filter((value): value is string => Boolean(value)))];
          const pages = await Promise.all(references.map(reference => loadWorkRailChats(client, false, reference)));
          const unique = new Map<string, CanonicalChatRecord>(); // at most two bounded 1,000-row pages
          for (const record of pages.flat()) unique.set(record.chat.id, record);
          const loaded = [...unique.values()].sort(compareCanonicalChatActivity).slice(0, 1000);
          if (!isCurrent()) return;
          setSnapshot(previous => {
            if (!isCurrent()) return previous;
            const known = previous?.client === client && previous.scope === scope
              && previous.authorityEpoch === authorityEpoch && previous.projectKey === projectKey ? previous.records : [];
            return { client, scope, authorityEpoch, projectKey, error: false, records: loaded.map(record => {
              const existing = known.find(item => item.chat.id === record.chat.id);
              return existing ? mergeCanonicalChatRecord(existing, record) : record;
            }) };
          });
        } catch (error: unknown) {
          console.warn("[project] Chat cards unavailable:", error instanceof Error ? error.name : "UnknownError");
          if (!isCurrent()) return;
          if (error instanceof AppError && error.category === "unauthorized") {
            scope?.revoke();
            setSnapshot(null);
            return;
          }
          setSnapshot(previous => !isCurrent() ? previous : ({ client, scope, authorityEpoch, projectKey,
            records: previous?.client === client && previous.scope === scope
              && previous.authorityEpoch === authorityEpoch && previous.projectKey === projectKey ? previous.records : [],
            error: true,
          }));
        }
      } while (isCurrent() && again);
      pending = false;
    };
    void refresh();
    const subscription = eventSource?.subscribe(event => {
      if (event.type === "chat.changed" && event.eventType === "run.message") return;
      void refresh();
    });
    return () => { current = false; subscription?.dispose(); };
  }, [client, active, scoped, scope, authorityEpoch, eventSource, project.id, project.slug, projectKey, refreshRequest]);
  const records = useMemo(() => scoped && snapshot && snapshot.client === client && snapshot.scope === scope && snapshot.authorityEpoch === authorityEpoch && snapshot.projectKey === projectKey ? snapshot.records : [], [scoped, snapshot, client, scope, authorityEpoch, projectKey]);
  const ids = useMemo(() => records.map(record => record.chat.id), [records]);
  const authoritative = useMemo(() => navigation.items.map(item => ({ chatId: item.chat.id, classification: item.classification })), [navigation.items]);
  const bots = useBotConversationSummaries(botAuthority.client, ids, active && scoped && ids.length > 0, undefined, authoritative);
  const chats = useMemo<ChatNavigationRecord[]>(() => {
    if (!client) return [];
    const matchesProject = (record: ChatNavigationRecord) => record.projectId === project.id || record.projectId === project.slug;
    if (!scoped) return navigation.items.filter(item => item.classification.kind === "ordinary" && matchesProject(item));
    // An inactive identity hook carries no classification; do not expose its Bot rows.
    if (!active) return [];
    if (!client.agents?.bots) {
      // An unavailable binding reader cannot prove older scoped rows ordinary.
      // The authenticated global projection can still prove the rows it contains.
      const ordinaryIds = new Set(navigation.items.filter(item => item.classification.kind === "ordinary").map(item => item.chat.id));
      return records.filter(record => matchesProject(record) && ordinaryIds.has(record.chat.id));
    }
    return records.filter(record => matchesProject(record)
      && !bots.unresolvedChatIds.includes(record.chat.id)
      && !bots.conversations.some(bot => bot.chatId === record.chat.id));
  }, [client, scoped, active, navigation.items, records, project.id, project.slug, bots.unresolvedChatIds, bots.conversations]);
  const scopedError = scoped && snapshot && snapshot.client === client && snapshot.scope === scope && snapshot.authorityEpoch === authorityEpoch && snapshot.projectKey === projectKey && snapshot.error;
  return { chats, error: Boolean(navigation.error || scopedError) };
}
