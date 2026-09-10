/** Keep ambiguous retries idempotent. One pending payload per scope, capped and expired. */
export function createChatMentionRequestTracker() {
  const pending = new Map<string, { payload: string; seed?: string; id: string; operation: "send" | "queue"; status: "unknown"; touched: number }>();
  let owner: unknown;
  return {
    resolve(identity: unknown, scope: string, payload: unknown, operation: "send" | "queue", seed?: string) {
      if (owner !== identity) { pending.clear(); owner = identity; }
      const now = Date.now();
      for (const [key, entry] of pending) if (now - entry.touched > 30 * 60_000) pending.delete(key);
      const serialized = JSON.stringify(payload);
      const previous = pending.get(scope);
      const sameRequest = previous?.payload === serialized && previous.seed === seed;
      const id = sameRequest
        ? previous.id : seed && previous?.seed !== seed ? seed : `req_${crypto.randomUUID().replaceAll("-", "")}`;
      pending.delete(scope);
      const entry = { payload: serialized, seed, id, operation: sameRequest ? previous.operation : operation, status: "unknown" as const, touched: now };
      pending.set(scope, entry);
      while (pending.size > 100) pending.delete(pending.keys().next().value!);
      return { clientRequestId: id, operation: entry.operation, status: entry.status };
    },
    accepted(scope: string, id: string) {
      if (pending.get(scope)?.id === id) pending.delete(scope);
    },
  };
}
