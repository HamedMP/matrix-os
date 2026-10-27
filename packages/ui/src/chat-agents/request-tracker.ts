import { ChatAdmissionUnconfirmed } from "../canonical-chat-admission.js";

/** Unknown requests never expire or evict into a new id. Known dispositions release capacity. */
export function createChatMentionRequestTracker() {
  const pending: Array<{ scope: string; payload: string; seed?: string; id: string; operation: "send" | "queue"; status: "unknown" }> = [];
  let owner: unknown;
  return {
    resolve(identity: unknown, scope: string, payload: unknown, operation: "send" | "queue", seed?: string) {
      if (owner !== identity) { pending.length = 0; owner = identity; }
      const serialized = JSON.stringify(payload);
      const previous = pending.find(entry => entry.scope === scope && entry.payload === serialized && entry.seed === seed);
      if (previous) return { clientRequestId: previous.id, operation: previous.operation, status: previous.status };
      if (pending.length >= 100) throw new ChatAdmissionUnconfirmed();
      const id = seed && !pending.some(entry => entry.id === seed) ? seed : `req_${crypto.randomUUID().replaceAll("-", "")}`;
      const entry = { scope, payload: serialized, seed, id, operation, status: "unknown" as const };
      pending.push(entry);
      return { clientRequestId: id, operation, status: entry.status };
    },
    accepted(scope: string, id: string) {
      const index = pending.findIndex(entry => entry.scope === scope && entry.id === id);
      if (index >= 0) pending.splice(index, 1);
    },
  };
}
