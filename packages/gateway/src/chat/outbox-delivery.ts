import type { ChatOutboxEvent, ChatOwner } from "./records.js";

const MAX_PENDING_EVENTS_PER_TRANSACTION = 100;
const MAX_RELEASE_CHECKS_PER_TRANSACTION = 100;
const MAX_ACTIVE_BATCHES = 128;

/** Trusted synchronous lease check; performs no IO and must return literal true. */
export type ChatCommitReleaseCheck = () => true;
export interface ChatOutboxBatch {
  events: PendingChatOutboxEvent[];
  checks: ChatCommitReleaseCheck[];
  state: "open" | "sealed" | "settled";
}

export type ChatOutboxSink = (input: { owner: ChatOwner; event: ChatOutboxEvent }) => void;
export type PendingChatOutboxEvent = { owner: ChatOwner; event: ChatOutboxEvent };

export class ChatOutboxDelivery {
  private sink: ChatOutboxSink | null = null;
  private released = false;
  private readonly pendingByExecutor = new WeakMap<object, ChatOutboxBatch>();
  private activeBatches = 0;

  registerSink(sink: ChatOutboxSink): { dispose(): void } {
    if (this.released) throw new Error("Chat outbox sink is unavailable");
    if (this.sink) throw new Error("Chat outbox sink already registered");
    this.sink = sink;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.sink === sink) this.sink = null;
      },
    };
  }

  begin(executor: object): ChatOutboxBatch {
    if (this.pendingByExecutor.has(executor) || this.activeBatches >= MAX_ACTIVE_BATCHES) {
      throw new Error("Chat transaction outbox capacity exceeded");
    }
    const batch: ChatOutboxBatch = { events: [], checks: [], state: "open" };
    this.pendingByExecutor.set(executor, batch);
    this.activeBatches++;
    return batch;
  }

  beforeRelease(executor: object, check: ChatCommitReleaseCheck): void {
    const batch = this.pendingByExecutor.get(executor);
    if (!batch || batch.state !== "open" || batch.checks.length >= MAX_RELEASE_CHECKS_PER_TRANSACTION) {
      throw new Error("Chat transaction release check unavailable");
    }
    batch.checks.push(check);
  }

  seal(executor: object): void {
    const batch = this.pendingByExecutor.get(executor);
    if (!batch || batch.state !== "open") throw new Error("Chat transaction outbox unavailable");
    batch.state = "sealed";
  }

  /** Called only by the actual transaction owner after COMMIT settles. */
  commit(batch: ChatOutboxBatch): void {
    if (batch.state !== "sealed") throw new Error("Chat transaction outbox unavailable");
    batch.state = "settled";
    // No awaited work between this whole-batch preflight and the first sink call.
    for (const check of batch.checks) {
      if (check() !== true) throw new Error("Chat transaction release unavailable");
    }
    this.flush(batch.events);
  }

  /** Retain the batch through COMMIT, then clear captured closures/content on every outcome. */
  end(executor: object): void {
    const batch = this.pendingByExecutor.get(executor);
    if (!batch) return;
    batch.state = "settled";
    batch.events.length = 0;
    batch.checks.length = 0;
    this.pendingByExecutor.delete(executor);
    this.activeBatches--;
  }

  capture(executor: object, event: PendingChatOutboxEvent): void {
    const batch = this.pendingByExecutor.get(executor);
    if (!batch) return;
    if (batch.state !== "open" || batch.events.length >= MAX_PENDING_EVENTS_PER_TRANSACTION) {
      throw new Error("Chat transaction outbox limit exceeded");
    }
    batch.events.push(event);
  }

  flush(pending: PendingChatOutboxEvent[]): void {
    const sink = this.released ? null : this.sink;
    if (!sink) return;
    for (const event of pending) {
      try {
        sink(event);
      } catch (error: unknown) {
        console.warn(
          "[chat/outbox-delivery] Sink delivery failed:",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    }
  }

  release(): void {
    this.released = true;
    this.sink = null;
  }
}
