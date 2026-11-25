import { performance } from "node:perf_hooks";
import { measureCodexDeliveryStage, recordCodexDeliveryStage } from "./codex-delivery-timing.js";
import { recordChatSendStage, startChatSendStage } from "../chat/send-timing.js";

/** Preserve the legacy store's serialization while making time spent waiting,
 * persisting and projecting separately observable. External calls inside a
 * mutation remain serialized; moving them requires authority revalidation.
 */
export function createThreadStateQueue<State>(options: {
  read(missingIsEmpty?: boolean): Promise<State>;
  write(state: State): Promise<void>;
  trim(state: State): State;
  publishChanges(previous: State, next: State): Promise<void>;
}) {
  let queue: Promise<void> = Promise.resolve();
  return {
    mutate<T>(fn: (state: State) => Promise<{ state: State; result: T }>, timing: { timeQueueWait?: boolean } = {}): Promise<T> {
      const queuedAt = performance.now();
      const chatQueuedAt = timing.timeQueueWait ? startChatSendStage() : undefined;
      const run = queue.then(async () => {
        recordChatSendStage("thread_store_queue_wait", chatQueuedAt);
        recordCodexDeliveryStage("store_queue_wait", queuedAt);
        const current = await measureCodexDeliveryStage("store_read", () => options.read());
        const { state, result } = await measureCodexDeliveryStage("store_mutation", () => fn(current));
        const persisted = await measureCodexDeliveryStage("store_write", async () => {
          const persisted = options.trim(state);
          await options.write(persisted);
          return persisted;
        });
        await measureCodexDeliveryStage("store_projection", () => options.publishChanges(current, persisted));
        return result;
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
    inspect<T>(fn: (state: State) => T | Promise<T>, missingIsEmpty = true): Promise<T> {
      const queuedAt = performance.now();
      const run = queue.then(async () => {
        recordCodexDeliveryStage("store_queue_wait", queuedAt);
        return fn(await measureCodexDeliveryStage("store_read", () => options.read(missingIsEmpty)));
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
    async drain(): Promise<void> { await queue; },
  };
}
