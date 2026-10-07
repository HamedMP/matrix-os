import type { BotInteraction, BotTaskSummary, ChatAgentListResponse } from '@matrix-os/contracts';
import type { ChatAgentClient } from '../client.js';

const IDENTITY_TTL_MS = 5 * 60_000;
const DISCOVERY_TTL_MS = 60_000;
const ATTENTION_TTL_MS = 15_000;
const FAILURE_TTL_MS = 1_000;
const MAX_QUEUED_READS = 2_301;
const MAX_LIBRARY_SUBSCRIBERS = 256;
type Entry<T> = { value?: T; error?: unknown; failed: boolean; touchedAt: number; verifiedAt?: number; token?: string; pending?: Promise<T> };

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
  function cache<T>(capacity: number, ttl: number, forceFailuresOnly = false, onSuccess?: (value: T) => void) {
    const entries = new Map<string, Entry<T>>();
    const read = (key: string, work: () => Promise<T>, token?: string, replacePending = false): Promise<T> => {
      let entry = entries.get(key);
      // A resumed rail must not wait for an abandoned hidden activation. Its
      // replacement still uses the bounded queue; detached results cannot publish.
      if (entry?.pending && replacePending && token !== entry.token) {
        entries.delete(key);
        entry = undefined;
      }
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
            current.value = value; current.verifiedAt = Date.now(); current.failed = false; current.error = undefined;
            if (entries.get(key) === current) onSuccess?.(value);
            return value;
          } catch (error: unknown) {
            if (requested !== current.token) continue;
            if (!forceFailuresOnly) current.value = undefined;
            current.failed = true; current.error = error;
            throw error;
          } finally { current.touchedAt = Date.now(); }
        }
      })().finally(() => { current.pending = undefined; });
      return current.pending;
    };
    // A synchronous successful identity projection shares the same bounded LRU
    // and TTL as async discovery. Undefined is unknown; null is verified ordinary.
    return Object.assign(read, { snapshot: (key: string): T | undefined => {
      const entry = entries.get(key);
      return entry?.verifiedAt !== undefined && Date.now() - entry.verifiedAt < ttl ? entry.value : undefined;
    } });
  }
  // One bounded verified definition snapshot survives transient failures and
  // component remounts. The exact client key fences owner/runtime/auth changes.
  let librarySnapshot: ChatAgentListResponse | undefined;
  const libraryListeners = new Set<() => void>();
  const subscribeLibrary = (listener: () => void) => {
    // Fail closed instead of silently evicting a live rail and leaving stale data.
    if (libraryListeners.size >= MAX_LIBRARY_SUBSCRIBERS && !libraryListeners.has(listener)) {
      throw new Error('Bot library subscription capacity reached');
    }
    libraryListeners.add(listener);
    return () => { libraryListeners.delete(listener); };
  };
  const library = cache<ChatAgentListResponse>(1, DISCOVERY_TTL_MS, false, value => {
    librarySnapshot = value;
    for (const listener of [...libraryListeners]) {
      try { listener(); }
      catch (error: unknown) {
        libraryListeners.delete(listener);
        console.warn('[bots] Library subscriber unavailable:', error instanceof Error ? error.name : 'UnknownError');
      }
    }
  });
  const directChats = cache<string | null>(100, DISCOVERY_TTL_MS);
  const identities = cache<string | null>(1_000, IDENTITY_TTL_MS, true);
  const attention = cache<BotInteraction[]>(1_100, ATTENTION_TTL_MS);
  const tasks = cache<BotTaskSummary[]>(100, ATTENTION_TTL_MS);
  return {
    subscribeLibrary,
    librarySnapshot: () => librarySnapshot,
    library: (token?: string, replacePending = false) => library('library', async () => {
      const value = await client.list();
      return { ...value, agents: value.agents.slice(0, 100) };
    }, token, replacePending),
    directChatSnapshot: (agentId: string) => directChats.snapshot(agentId),
    directBotSnapshot: (chatId: string) => identities.snapshot(chatId),
    directChat: (agentId: string, token?: string) => directChats(agentId, () => client.bots!.directChat(agentId), token),
    directBot: (chatId: string, token?: string) => identities(chatId, () => client.bots!.directBot(chatId), token),
    tasks: (chatId: string, token?: string) => tasks(chatId, () => client.bots!.tasks(chatId), token),
    interactions: (chatId: string, token?: string) => attention(chatId, () => client.bots!.interactions(chatId), token),
  };
}
