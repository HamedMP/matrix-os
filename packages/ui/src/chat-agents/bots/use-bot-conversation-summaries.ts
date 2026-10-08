import { useEffect, useRef, useState } from 'react';
import type { ChatAgentClient } from '../client.js';
import { botSummaryReads } from './bot-summary-reads.js';

export type BotConversationSummary = { chatId: string; agentId: string; name: string; pendingApprovalCount: number };
export type BotConversationSummaries = { conversations: BotConversationSummary[]; unresolvedChatIds: string[]; loading: boolean; error: string | null };
const MAX_RECORDS = 1000;
const empty: BotConversationSummaries = { conversations: [], unresolvedChatIds: [], loading: false, error: null };
type Snapshot = { client: ChatAgentClient; key: string; value: BotConversationSummaries };
type Binding = { agentId: string; name: string };
function cachedIdentities(reads: ReturnType<typeof botSummaryReads>, ids: readonly string[]) {
  const bindings = new Map<string, Binding>();
  const unresolved = new Set(ids);
  const agents = reads.librarySnapshot()?.agents ?? [];
  for (const agent of agents.filter(agent => !agent.archived)) {
    const chatId = reads.directChatSnapshot(agent.id);
    if (chatId) { bindings.set(chatId, { agentId: agent.id, name: agent.name }); unresolved.delete(chatId); }
  }
  for (const chatId of ids.slice(0, MAX_RECORDS)) {
    const agentId = reads.directBotSnapshot(chatId);
    if (agentId === undefined) continue;
    unresolved.delete(chatId);
    if (agentId) bindings.set(chatId, { agentId, name: agents.find(agent => agent.id === agentId)?.name ?? 'Your bot' });
  }
  return { bindings, unresolved };
}
async function bounded<T>(values: readonly T[], work: (value: T) => Promise<void>) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (index < values.length) await work(values[index++]!);
  }));
}
/** Authenticated binding projection, shared across renderers. Unknown identities never become ordinary Chats. */
export function useBotConversationSummaries(client: ChatAgentClient | undefined, recordIds: readonly string[], active = true, refreshKey?: number): BotConversationSummaries {
  const idsKey = JSON.stringify([...new Set(recordIds)]);
  const refreshRevision = useRef<{ client: ChatAgentClient; key: number | undefined } | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [baseline, setBaseline] = useState<Snapshot | null>(null);
  const committed = useRef<Snapshot | null>(null);
  let projection = empty;
  if (active && client?.bots) {
    if (snapshot?.client === client && snapshot.key === idsKey) projection = snapshot.value;
    else if (baseline?.client === client && baseline.key === idsKey) projection = baseline.value;
    else {
      // React owns this render adjustment: an abandoned concurrent render must
      // not mutate the committed cohort used by a live refresh.
      const next = { client, key: idsKey, value: retainedIdentities(snapshot, client, recordIds) };
      setBaseline(next);
      projection = next.value;
    }
  }
  useEffect(() => {
    committed.current = active && client?.bots ? { client, key: idsKey, value: projection } : null;
  }, [active, client, idsKey, projection]);
  useEffect(() => {
    if (!active || !client?.bots) return;
    const reads = botSummaryReads(client);
    const revisionChanged = refreshRevision.current?.client === client && refreshRevision.current.key !== refreshKey;
    refreshRevision.current = { client, key: refreshKey };
    const eventToken = revisionChanged ? `event:${refreshKey}` : undefined;
    const allIds = JSON.parse(idsKey) as string[];
    const ids = allIds.slice(0, MAX_RECORDS);
    let current = true;
    let pending = false;
    let queuedToken: string | undefined;
    const refresh = async (token?: string, attentionToken = token) => {
      if (pending) { if (token !== undefined) queuedToken = token; return; }
      pending = true;
      let failed = false;
      const { bindings, unresolved } = cachedIdentities(reads, allIds);
      const checking = new Set(ids);
      // Ordinary results stay staged even when a Bot update publishes first.
      // The baseline is captured once per cohort, never from a live partial cache.
      const staged = new Set(committed.current?.client === client && committed.current.key === idsKey
        ? committed.current.value.unresolvedChatIds : allIds);
      for (const chatId of bindings.keys()) staged.delete(chatId);
      const publishIdentities = () => {
        if (current) setSnapshot(previous => {
          const known = previous?.client === client ? previous : null;
          const verified = new Set(known ? JSON.parse(known.key) as string[] : []);
          const priorUnknown = new Set(known?.value.unresolvedChatIds ?? []);
          const visibleBindings = new Map(bindings);
          // TTL expiry owes fresh verification, but does not invalidate mounted
          // evidence while that identity's own request is still pending.
          for (const bot of known?.value.conversations ?? []) {
            if (checking.has(bot.chatId) && !visibleBindings.has(bot.chatId)) visibleBindings.set(bot.chatId, bot);
          }
          return { client, key: idsKey, value: {
            conversations: [...visibleBindings].map(([chatId, bot]) => ({ chatId, ...bot,
              pendingApprovalCount: known?.value.conversations.find(item => item.chatId === chatId && item.agentId === bot.agentId)?.pendingApprovalCount ?? 0,
            })),
            unresolvedChatIds: allIds.filter(id => (unresolved.has(id) || staged.has(id))
              && (!checking.has(id) || !verified.has(id) || priorUnknown.has(id))),
            loading: true, error: null,
          } };
        });
      };
      publishIdentities();
      try {
        let agents: Awaited<ReturnType<ChatAgentClient['list']>>['agents'] = [];
        try { agents = (await reads.library(token)).agents; }
        catch (error: unknown) { failed = true; console.warn('[bots] List unavailable:', error instanceof Error ? error.name : 'UnknownError'); }
        if (!current) return;
        await bounded(agents.filter(agent => !agent.archived), async agent => {
          if (!current) return;
          try {
            const chatId = await reads.directChat(agent.id, token);
            if (current && chatId) {
              checking.delete(chatId);
              const known = bindings.get(chatId);
              bindings.set(chatId, { agentId: agent.id, name: agent.name });
              staged.delete(chatId);
              if (unresolved.delete(chatId) || known?.agentId !== agent.id || known?.name !== agent.name) publishIdentities();
            }
          }
          catch (error: unknown) { failed = true; console.warn('[bots] Binding unavailable:', error instanceof Error ? error.name : 'UnknownError'); }
        });
        await bounded(ids.filter(id => !bindings.has(id)), async chatId => {
          if (!current) return;
          try {
            const agentId = await reads.directBot(chatId, token);
            if (!current) return;
            checking.delete(chatId);
            const wasUnresolved = unresolved.delete(chatId);
            const known = bindings.get(chatId);
            if (agentId) {
              bindings.set(chatId, { agentId, name: agents.find(agent => agent.id === agentId)?.name ?? 'Your bot' });
              staged.delete(chatId);
            } else bindings.delete(chatId);
            if (agentId && (wasUnresolved || known?.agentId !== agentId)) publishIdentities();
          } catch (error: unknown) { checking.delete(chatId); failed = true; unresolved.add(chatId); console.warn('[bots] Identity unavailable:', error instanceof Error ? error.name : 'UnknownError'); }
        });
        // Commit the identity cohort before potentially slow approval reads.
        if (!current) return;
        reads.publishOrdinaryIdentities(ids.filter(id => !unresolved.has(id) && !bindings.has(id)));
        staged.clear();
        publishIdentities();
        const conversations = [...bindings].map(([chatId, bot]) => ({ chatId, ...bot, pendingApprovalCount: 0 }));
        await bounded(conversations, async conversation => {
          if (!current || !agents.find(agent => agent.id === conversation.agentId)?.recipeRef) return;
          try { const interactions = await reads.interactions(conversation.chatId, attentionToken);
            conversation.pendingApprovalCount = interactions.filter(item => item.kind === 'approval' && item.status === 'pending' && item.expiresAt > new Date().toISOString()).length;
          } catch (error: unknown) { failed = true; console.warn('[bots] Attention unavailable:', error instanceof Error ? error.name : 'UnknownError'); }
        });
        if (current) setSnapshot({ client, key: idsKey, value: { conversations, unresolvedChatIds: [...unresolved], loading: false, error: failed ? 'Some bot status is unavailable. Refresh to try again.' : null } });
      } catch (error: unknown) {
        console.warn('[bots] List unavailable:', error instanceof Error ? error.name : 'UnknownError');
        if (current) setSnapshot(previous => {
          const known = previous?.client === client ? previous : null;
          const verified = new Set(known ? JSON.parse(known.key) as string[] : []);
          const unresolved = new Set(known?.value.unresolvedChatIds ?? []);
          return { client, key: idsKey, value: {
            conversations: known ? known.value.conversations.map(item => ({...item,pendingApprovalCount:0})) : [],
            unresolvedChatIds: allIds.filter(id => !verified.has(id) || unresolved.has(id)),
            loading:false,error:'Bot status is unavailable. Refresh to try again.',
          }};
        });
      } finally {
        pending = false;
        if (current && queuedToken !== undefined) {
          const next = queuedToken; queuedToken = undefined; void refresh(next);
        }
      }
    };
    void refresh(eventToken);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(undefined, `poll:${Math.floor(Date.now() / 15_000)}`); }, 15_000);
    const focus = (event: FocusEvent) => { void refresh(`focus:${event.timeStamp}`); };
    window.addEventListener('focus', focus);
    return () => { current = false; window.clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [client, idsKey, active, refreshKey]);
  return projection;
}

/** Capture once on a changed list/remount; rerenders must not reveal staged cache writes. */
function retainedIdentities(snapshot: Snapshot | null, client: ChatAgentClient, recordIds: readonly string[]): BotConversationSummaries {
  const previous = snapshot?.client === client ? snapshot.value : empty;
  const verifiedIds = new Set(snapshot?.client === client ? JSON.parse(snapshot.key) as string[] : []);
  const { bindings, unresolved } = cachedIdentities(botSummaryReads(client), [...new Set(recordIds)]);
  for (const id of verifiedIds) if (!previous.unresolvedChatIds.includes(id)) unresolved.delete(id);
  for (const conversation of previous.conversations) {
    if (!bindings.has(conversation.chatId)) bindings.set(conversation.chatId, conversation);
  }
  return { ...previous, loading: true,
    conversations: [...bindings].map(([chatId, bot]) => previous.conversations.find(item => item.chatId === chatId && item.agentId === bot.agentId)
      ?? { chatId, ...bot, pendingApprovalCount: 0 }),
    unresolvedChatIds: [...unresolved],
  };
}
