import { useEffect, useRef, useState } from 'react';
import type { ChatAgentClient } from '../client.js';

export type BotConversationSummary = { chatId: string; agentId: string; name: string; pendingApprovalCount: number };
export type BotConversationSummaries = { conversations: BotConversationSummary[]; unresolvedChatIds: string[]; loading: boolean; error: string | null };
const MAX_RECORDS = 1000;
const BINDING_TTL_MS = 30_000;
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
  const bindingCache = useRef<{ client: ChatAgentClient; entries: Record<string, { agentId: string | null; touchedAt: number }> } | null>(null);
  const [snapshot, setSnapshot] = useState<{ client: ChatAgentClient; key: string; value: BotConversationSummaries } | null>(null);
  useEffect(() => {
    if (!active || !client?.bots) return;
    const bots = client.bots;
    if (bindingCache.current?.client !== client) bindingCache.current = { client, entries: {} };
    const cache = bindingCache.current.entries;
    const allIds = JSON.parse(idsKey) as string[];
    const ids = allIds.slice(0, MAX_RECORDS);
    let current = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      let failed = false;
      const bindings = new Map<string, { agentId: string; name: string }>();
      const unresolved = new Set<string>(allIds.slice(MAX_RECORDS));
      try {
        const library = await client.list();
        if (!current) return;
        const agents = library.agents.slice(0, 100);
        await bounded(agents.filter(agent => agent.recipeRef), async agent => {
          if (!current) return;
          try { const chatId = await bots.directChat(agent.id); if (chatId) bindings.set(chatId, { agentId: agent.id, name: agent.name }); }
          catch (error: unknown) { failed = true; console.warn('[bots] Binding unavailable:', error instanceof Error ? error.name : 'UnknownError'); }
        });
        await bounded(ids.filter(id => !bindings.has(id)), async chatId => {
          if (!current) return;
          try {
            const cached = cache[chatId];
            const agentId = cached && Date.now() - cached.touchedAt < BINDING_TTL_MS ? cached.agentId : await bots.directBot(chatId);
            if (!current) return;
            if (!cached || Date.now() - cached.touchedAt >= BINDING_TTL_MS) {
              delete cache[chatId];
              cache[chatId] = { agentId, touchedAt: Date.now() };
              for (const key of Object.keys(cache).slice(0, -MAX_RECORDS)) delete cache[key];
            }
            if (agentId) bindings.set(chatId, { agentId, name: agents.find(agent => agent.id === agentId)?.name ?? 'Your bot' });
          } catch (error: unknown) { failed = true; unresolved.add(chatId); console.warn('[bots] Identity unavailable:', error instanceof Error ? error.name : 'UnknownError'); }
        });
        const conversations = [...bindings].map(([chatId, bot]) => ({ chatId, ...bot, pendingApprovalCount: 0 }));
        await bounded(conversations, async conversation => {
          if (!current) return;
          try { const interactions = await bots.interactions(conversation.chatId);
            conversation.pendingApprovalCount = interactions.filter(item => item.kind === 'approval' && item.status === 'pending' && item.expiresAt > new Date().toISOString()).length;
          } catch (error: unknown) { failed = true; console.warn('[bots] Attention unavailable:', error instanceof Error ? error.name : 'UnknownError'); }
        });
        if (current) setSnapshot({ client, key: idsKey, value: { conversations, unresolvedChatIds: [...unresolved], loading: false, error: failed ? 'Some bot status is unavailable. Refresh to try again.' : null } });
      } catch (error: unknown) {
        console.warn('[bots] List unavailable:', error instanceof Error ? error.name : 'UnknownError');
        if (current) setSnapshot(previous => ({ client, key: idsKey, value: { conversations: previous?.client === client ? previous.value.conversations.map(item => ({ ...item, pendingApprovalCount: 0 })) : [], unresolvedChatIds: allIds, loading: false, error: 'Bot status is unavailable. Refresh to try again.' } }));
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15_000);
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => { current = false; window.clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [client, idsKey, active, refreshKey]);
  if (!active || !client?.bots) return empty;
  if (snapshot?.client === client && snapshot.key === idsKey) return snapshot.value;
  return { ...empty, loading: true, unresolvedChatIds: [...new Set(recordIds)] };
}
