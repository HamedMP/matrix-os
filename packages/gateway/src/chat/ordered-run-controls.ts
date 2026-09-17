import type { ChatOwner } from "./records.js";
import { CanonicalChatOrchestrationError } from "./orchestration-errors.js";

type Work = { execute(): Promise<void>; reject(error: Error): void };
type Queue = { active: boolean; work: Work[] };
function unavailable() {
  return new CanonicalChatOrchestrationError({ code: "run_unavailable", safeMessage: "This Run cannot accept another control right now.", retryable: true, recoveryActions: ["retry"] }, 503);
}

/** Serialize admission and delivery together, before any control-specific DB awaits.
 * Entries are capped and removed when idle; shutdown rejects queued work.
 */
export function createOrderedRunControls() {
  const queues = new Map<string, Queue>();
  let closed = false;
  async function drain(key: string, queue: Queue) {
    queue.active = true;
    try {
      while (queue.work.length) await queue.work.shift()!.execute();
    } finally {
      queue.active = false;
      if (queues.get(key) === queue) queues.delete(key);
    }
  }
  return {
    wrap<Tail extends unknown[], Result>(operation: (owner: ChatOwner, chatId: string, runId: string, ...tail: Tail) => Promise<Result>) {
      return (owner: ChatOwner, chatId: string, runId: string, ...tail: Tail): Promise<Result> => {
        const key = JSON.stringify([owner.type, owner.ownerId, chatId, runId]);
        if (closed || (!queues.has(key) && queues.size >= 64)) return Promise.reject(unavailable());
        const queue = queues.get(key) ?? { active: false, work: [] };
        if (queue.work.length + Number(queue.active) >= 16) return Promise.reject(unavailable());
        queues.set(key, queue);
        return new Promise<Result>((resolve, reject) => {
          queue.work.push({ reject, async execute() {
            try { resolve(await operation(owner, chatId, runId, ...tail)); } catch (error: unknown) { reject(error); }
          } });
          if (!queue.active) void drain(key, queue);
        });
      };
    },
    close() {
      closed = true;
      for (const queue of queues.values()) {
        for (const work of queue.work.splice(0)) work.reject(unavailable());
      }
    },
  };
}
