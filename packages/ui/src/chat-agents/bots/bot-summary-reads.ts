import type { BotInteraction, ChatAgentListResponse } from '@matrix-os/contracts';
import type { ChatAgentClient } from '../client.js';

const IDENTITY_TTL_MS = 5 * 60_000;
const DISCOVERY_TTL_MS = 60_000;
const ATTENTION_TTL_MS = 15_000;
const FAILURE_TTL_MS = 1_000;
const MAX_QUEUED_READS = 2_301;
type Entry<T> = { value?: T; error?: unknown; failed: boolean; touchedAt: number; token?: string; pending?: Promise<T> };

/** Client objects already fence owner, runtime and auth generation. Weak keys do
 * not retain signed-out clients; each live client's caches and queue are capped. */
const clients = new WeakMap<ChatAgentClient, ReturnType<typeof createReads>>();
export function botSummaryReads(client: ChatAgentClient) {
  let reads = clients.get(client);
  if (!reads) { reads = createReads(client); clients.set(client, reads); }
  return reads;
}

function createReads(client: ChatAgentClient) {
  let running = 0;
  const queue: Array<() => void> = [];
  function schedule<T>(work: () => Promise<T>): Promise<T> {
    if (queue.length >= MAX_QUEUED_READS) return Promise.reject(new Error('Bot summary read capacity reached'));
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        running++;
        void Promise.resolve().then(work).then(resolve, reject).finally(() => {
          running--;
          queue.shift()?.();
        });
      };
      if (running < 4) start(); else queue.push(start);
    });
  }
  function cache<T>(capacity: number, ttl: number, forceFailuresOnly = false) {
    const entries = new Map<string, Entry<T>>();
    return (key: string, work: () => Promise<T>, token?: string): Promise<T> => {
      let entry = entries.get(key);
      if (entry) {
        entries.delete(key); entries.set(key, entry);
        if (entry.pending) {
          // A newer focus/event during an old read owes one fresh follow-up.
          if (token !== undefined && !forceFailuresOnly) entry.token = token;
          return entry.pending;
        }
        const fresh = Date.now() - entry.touchedAt < (entry.failed ? FAILURE_TTL_MS : ttl);
        if (fresh && (token === undefined || token === entry.token || (forceFailuresOnly && !entry.failed))) {
          return entry.failed ? Promise.reject(entry.error) : Promise.resolve(entry.value as T);
        }
      } else {
        if (entries.size >= capacity) {
          const oldest = [...entries].find(([, value]) => !value.pending);
          if (!oldest) return Promise.reject(new Error('Bot summary cache capacity reached'));
          entries.delete(oldest[0]);
        }
        entry = { failed: false, touchedAt: 0 };
        entries.set(key, entry);
      }
      entry.token = token;
      const current = entry;
      current.pending = (async () => {
        while (true) {
          const requested = current.token;
          try {
            const value = await schedule(work);
            if (requested !== current.token) continue;
            current.value = value; current.failed = false; current.error = undefined;
            return value;
          } catch (error: unknown) {
            if (requested !== current.token) continue;
            current.value = undefined; current.failed = true; current.error = error;
            throw error;
          } finally { current.touchedAt = Date.now(); }
        }
      })().finally(() => { current.pending = undefined; });
      return current.pending;
    };
  }
  const library = cache<ChatAgentListResponse>(1, DISCOVERY_TTL_MS);
  const directChats = cache<string | null>(100, DISCOVERY_TTL_MS);
  const identities = cache<string | null>(1_000, IDENTITY_TTL_MS, true);
  const attention = cache<BotInteraction[]>(1_100, ATTENTION_TTL_MS);
  return {
    library: (token?: string) => library('library', async () => {
      const value = await client.list();
      return { ...value, agents: value.agents.slice(0, 100) };
    }, token),
    directChat: (agentId: string, token?: string) => directChats(agentId, () => client.bots!.directChat(agentId), token),
    directBot: (chatId: string, token?: string) => identities(chatId, () => client.bots!.directBot(chatId), token),
    interactions: (chatId: string, token?: string) => attention(chatId, () => client.bots!.interactions(chatId), token),
  };
}
