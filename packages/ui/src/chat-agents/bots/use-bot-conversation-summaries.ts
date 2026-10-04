import { useEffect, useRef, useState } from 'react';
import type { ChatAgentClient } from '../client.js';
import { botSummaryReads } from './bot-summary-reads.js';

export type BotConversationSummary = { chatId: string; agentId: string; name: string; pendingApprovalCount: number };
export type BotConversationSummaries = { conversations: BotConversationSummary[]; unresolvedChatIds: string[]; loading: boolean; error: string | null };
const MAX_RECORDS = 1000;
const empty: BotConversationSummaries = { conversations: [], unresolvedChatIds: [], loading: false, error: null };
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
  const [snapshot, setSnapshot] = useState<{ client: ChatAgentClient; key: string; value: BotConversationSummaries } | null>(null);
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
      const bindings = new Map<string, { agentId: string; name: string }>();
      const unresolved = new Set<string>(allIds.slice(MAX_RECORDS));
      try {
        let agents: Awaited<ReturnType<ChatAgentClient['list']>>['agents'] = [];
        try { agents = (await reads.library(token)).agents; }
        catch (error: unknown) { failed = true; console.warn('[bots] List unavailable:', error instanceof Error ? error.name : 'UnknownError'); }
        if (!current) return;
        await bounded(agents.filter(agent => agent.recipeRef), async agent => {
          if (!current) return;
          try { const chatId = await reads.directChat(agent.id, token); if (chatId) bindings.set(chatId, { agentId: agent.id, name: agent.name }); }
          catch (error: unknown) { failed = true; console.warn('[bots] Binding unavailable:', error instanceof Error ? error.name : 'UnknownError'); }
        });
        await bounded(ids.filter(id => !bindings.has(id)), async chatId => {
          if (!current) return;
          try {
            const agentId = await reads.directBot(chatId, token);
            if (!current) return;
            if (agentId) bindings.set(chatId, { agentId, name: agents.find(agent => agent.id === agentId)?.name ?? 'Your bot' });
          } catch (error: unknown) { failed = true; unresolved.add(chatId); console.warn('[bots] Identity unavailable:', error instanceof Error ? error.name : 'UnknownError'); }
        });
        const conversations = [...bindings].map(([chatId, bot]) => ({ chatId, ...bot, pendingApprovalCount: 0 }));
        await bounded(conversations, async conversation => {
          if (!current) return;
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
  if (!active || !client?.bots) return empty;
  if (snapshot?.client === client && snapshot.key === idsKey) return snapshot.value;
  // A changed list is a background refresh within this authenticated client.
  // Keep verified identities visible; only new/unverified IDs wait for binding lookup.
  const previous = snapshot?.client === client ? snapshot.value : empty;
  const verifiedIds = new Set(snapshot?.client === client ? JSON.parse(snapshot.key) as string[] : []);
  const unresolved = new Set(previous.unresolvedChatIds);
  return { ...previous, loading: true, unresolvedChatIds: [...new Set(recordIds)].filter(id => !verifiedIds.has(id) || unresolved.has(id)) };
}
