/** Keep ambiguous retries idempotent. One pending payload per scope, capped and expired. */
export function createChatMentionRequestTracker() {
  const pending = new Map<string, { payload: string; seed?: string; id: string; touched: number }>();
  let owner: unknown;
  return {
    get(identity: unknown, scope: string, payload: unknown, seed?: string): string {
      if (owner !== identity) { pending.clear(); owner = identity; }
      const now = Date.now();
      for (const [key, entry] of pending) if (now - entry.touched > 30 * 60_000) pending.delete(key);
      const serialized = JSON.stringify(payload);
      const previous = pending.get(scope);
      const id = previous?.payload === serialized && previous.seed === seed
        ? previous.id : seed && previous?.seed !== seed ? seed : `req_${crypto.randomUUID().replaceAll("-", "")}`;
      pending.delete(scope);
      pending.set(scope, { payload: serialized, seed, id, touched: now });
      while (pending.size > 100) pending.delete(pending.keys().next().value!);
      return id;
    },
    accepted(scope: string, id: string) {
      if (pending.get(scope)?.id === id) pending.delete(scope);
    },
  };
}
